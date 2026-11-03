#!/usr/bin/env node
// Task C helper: break a model provider in TrueForge on purpose, to demonstrate the fallback.
//
//   node scripts/simulate-failure.mjs invalid-key  [provider]   # default provider: nvidia
//   node scripts/simulate-failure.mjs unreachable  [provider]
//   node scripts/simulate-failure.mjs rate-limited [provider]   # keeps running: a local endpoint
//                                                               # that answers 429 (Ctrl+C stops it)
//   node scripts/register-models.mjs --env ../.env            # restore every provider afterwards
//
// The same can be done by hand in the TrueForge UI (Settings → Model providers). Only the stored
// provider settings change; the extension and the workspace are not touched.
import { createServer } from 'node:http';

const MODES = ['invalid-key', 'unreachable', 'rate-limited'];
const [mode, name = 'nvidia'] = process.argv.slice(2);
const trueforge = 'http://127.0.0.1:8790';
const STUB_PORT = 8799;
if (!MODES.includes(mode)) {
  console.error(`usage: node scripts/simulate-failure.mjs ${MODES.join('|')} [provider]`);
  process.exit(1);
}

const list = await fetch(`${trueforge}/api/v1/settings/model-providers`)
  .then(r => r.json())
  .catch(err => {
    console.error(`Cannot reach TrueForge at ${trueforge}: ${err.message}`);
    process.exit(1);
  });
const items = Array.isArray(list?.data) ? list.data : Array.isArray(list) ? list : (list?.data?.items ?? []);
const stored = items.map(p => p.manifest ?? p).find(m => m.name === name);
if (!stored) {
  console.error(`No provider named "${name}" in TrueForge.`);
  process.exit(1);
}

if (mode === 'rate-limited') {
  // An OpenAI-compatible endpoint that is always "busy": every call gets 429 Too Many Requests.
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    calls++;
    console.log(`  ${new Date().toLocaleTimeString()}  ${req.method} ${req.url} -> 429 (call ${calls})`);
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: { message: 'Rate limit reached (simulated)', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(STUB_PORT, '127.0.0.1', resolve);
  }).catch(err => {
    console.error(`Cannot listen on 127.0.0.1:${STUB_PORT}: ${err.message}`);
    process.exit(1);
  });
}

// The stored key comes back redacted; sent back unchanged, TrueForge keeps the real key.
const manifest =
  mode === 'invalid-key'
    ? { ...stored, auth: { ...stored.auth, api_key: 'invalid-key-for-the-task-c-demo' } }
    : { ...stored, base_url: mode === 'unreachable' ? 'http://127.0.0.1:9/v1' : `http://127.0.0.1:${STUB_PORT}/v1` };
const res = await fetch(`${trueforge}/api/v1/settings/model-providers`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ manifest }),
});
if (!res.ok) {
  console.error(`FAILED (HTTP ${res.status}) ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
console.log(
  {
    'invalid-key': `- ${name}: API key replaced with an invalid one`,
    unreachable: `- ${name}: base_url set to an unreachable endpoint (http://127.0.0.1:9/v1)`,
    'rate-limited': `- ${name}: base_url set to a local endpoint that answers 429 (http://127.0.0.1:${STUB_PORT}/v1). Leave this running; Ctrl+C stops it.`,
  }[mode],
);
console.log('Restore with: node scripts/register-models.mjs --env ../.env');
