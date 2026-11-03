#!/usr/bin/env node
// Probe OpenAI-compatible models for what an agent needs: a STREAMED, correctly parsed tool call.
//
//   export API_KEY=...        # never pass keys on the command line (shell history)
//   node scripts/probe-models.mjs https://integrate.api.nvidia.com/v1 model/one model/two ...
//
// Prints one line per model: PASS (tool call streamed), TEXT (answered without calling the tool),
// or the HTTP error, with time-to-first-token and total time.
const [baseUrl, ...models] = process.argv.slice(2);
const key = process.env.API_KEY;
if (!baseUrl || models.length === 0 || !key) {
  console.error('usage: API_KEY=... node scripts/probe-models.mjs <base_url> <model> [model ...]');
  process.exit(2);
}

const body = model => ({
  model,
  stream: true,
  max_tokens: 400,
  temperature: 0.2,
  messages: [
    { role: 'system', content: 'You are a coding agent. Use tools when they help; call them immediately.' },
    { role: 'user', content: 'Find where the function get_debug_flag is defined in this repository. Use the tool.' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'search_code',
        description: 'Search the workspace for text and return matching lines',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    },
  ],
});

async function probe(model) {
  const started = Date.now();
  let firstAt = null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body(model)),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 140);
      return { model, verdict: `HTTP ${res.status}`, detail: text };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let toolName = '';
    let toolArgs = '';
    let content = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstAt === null) firstAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
        try {
          const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta ?? {};
          for (const c of delta.tool_calls ?? []) {
            toolName += c.function?.name ?? '';
            toolArgs += c.function?.arguments ?? '';
          }
          content += delta.content ?? '';
        } catch {
          // keep-alive or partial line
        }
      }
    }
    const ttft = firstAt ? ((firstAt - started) / 1000).toFixed(1) : '-';
    const total = ((Date.now() - started) / 1000).toFixed(1);
    if (toolName) {
      return { model, verdict: 'PASS', detail: `${toolName}(${toolArgs.slice(0, 60)})  first ${ttft}s, total ${total}s` };
    }
    return { model, verdict: 'TEXT', detail: `no tool call; said: ${content.replace(/\s+/g, ' ').slice(0, 80)}  (${total}s)` };
  } catch (err) {
    return { model, verdict: 'ERROR', detail: err.name === 'AbortError' ? 'timed out after 120 s' : String(err.message) };
  } finally {
    clearTimeout(timer);
  }
}

for (const model of models) {
  const r = await probe(model);
  console.log(`${r.verdict.padEnd(8)} ${r.model.padEnd(44)} ${r.detail}`);
}
