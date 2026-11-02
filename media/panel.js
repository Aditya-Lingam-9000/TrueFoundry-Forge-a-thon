// Forge Agent panel (webview). Plain JS, no framework. Renders streamed TrueForge events.
(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const newBtn = document.getElementById('new');
  const openBtn = document.getElementById('open');
  const statusEl = document.getElementById('status');
  const modelEl = document.getElementById('model');

  const bubbles = new Map(); // messageId -> { el, text, reasoningEl, reasoning }
  const toolCards = new Map(); // callId -> element
  const reviewCards = new Map(); // callId -> element
  const approvalCards = new Map(); // callId -> element
  const appliedCards = new Map(); // changeId -> element
  let busy = false;

  const REVIEW_LABEL = {
    pending: 'waiting for your review in the editor',
    accepted: 'accepted',
    partial: 'partly accepted',
    rejected: 'rejected — nothing written',
    invalid: 'could not be prepared — sent back to the agent',
    cancelled: 'cancelled — nothing written',
  };

  function button(label, cls, onClick) {
    const b = el('button', cls, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function renderReview(m) {
    let card = reviewCards.get(m.callId);
    if (!card) {
      card = el('div', 'card review');
      reviewCards.set(m.callId, card);
      log.appendChild(card);
    }
    card.className = 'card review ' + m.state;
    card.textContent = '';
    const title = el('div', 'card-title');
    title.appendChild(el('span', null, '📝 ' + m.path));
    if (m.hunks) title.appendChild(el('span', 'muted', '  ' + m.hunks + ' hunk(s) · +' + m.added + ' −' + m.removed));
    card.appendChild(title);
    card.appendChild(el('div', 'card-state', REVIEW_LABEL[m.state] || m.state));
    if (m.detail) card.appendChild(el('div', 'card-detail', m.detail));
    if (m.state === 'pending') {
      const row = el('div', 'row');
      row.appendChild(button('Open review', '', () => vscode.postMessage({ type: 'openReview', callId: m.callId })));
      card.appendChild(row);
    }
  }

  function renderApproval(m) {
    let card = approvalCards.get(m.callId);
    if (!card) {
      card = el('div', 'card approval');
      approvalCards.set(m.callId, card);
      log.appendChild(card);
    }
    card.className = 'card approval ' + m.state;
    card.textContent = '';
    card.appendChild(el('div', 'card-title', '⚡ ' + m.title));
    card.appendChild(el('pre', 'card-command', m.detail));
    if (m.state === 'pending') {
      const row = el('div', 'row');
      row.appendChild(button('Allow', '', () => vscode.postMessage({ type: 'approve', callId: m.callId, allow: true })));
      row.appendChild(button('Deny', 'secondary', () => vscode.postMessage({ type: 'approve', callId: m.callId, allow: false })));
      card.appendChild(row);
    } else {
      card.appendChild(el('div', 'card-state', m.state));
    }
  }

  function renderApplied(m) {
    for (const c of appliedCards.values()) {
      const b = c.querySelector('button');
      if (b) b.remove(); // only the most recent change can be reverted
    }
    const card = el('div', 'card applied');
    card.appendChild(el('div', 'card-title', '✅ ' + m.path));
    card.appendChild(el('div', 'card-detail', m.summary));
    const row = el('div', 'row');
    row.appendChild(button('Revert this change', 'secondary', () => vscode.postMessage({ type: 'revert', changeId: m.changeId })));
    card.appendChild(row);
    appliedCards.set(m.changeId, card);
    log.appendChild(card);
  }

  function renderReverted(m) {
    const card = appliedCards.get(m.changeId);
    if (card) {
      card.className = 'card applied reverted';
      const b = card.querySelector('button');
      if (b) b.remove();
      card.appendChild(el('div', 'card-state', '↩ reverted'));
    }
    appliedCards.delete(m.changeId);
  }

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Some models leak raw tool-call tags into their text; never show them to the user.
  function clean(text) {
    return text.replace(/<\/?tool_call>/g, '').replace(/\s+$/, '');
  }

  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b;
    stopBtn.disabled = !b;
    if (b) setStatus('info', 'Working…');
  }

  function setStatus(kind, text) {
    statusEl.className = 'status ' + kind;
    statusEl.textContent = text;
  }

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  newBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  openBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', event => {
    const m = event.data;
    switch (m.type) {
      case 'user': {
        const hint = log.querySelector('.hint');
        if (hint) hint.remove();
        log.appendChild(el('div', 'msg user', m.text));
        break;
      }
      case 'assistantStart': {
        if (bubbles.has(m.messageId)) break;
        const wrap = el('div', 'msg assistant');
        const reasoningEl = el('details', 'reasoning');
        reasoningEl.appendChild(el('summary', null, 'thinking'));
        const reasoningBody = el('div', 'reasoning-body');
        reasoningEl.appendChild(reasoningBody);
        reasoningEl.hidden = true;
        const body = el('div', 'body');
        wrap.appendChild(reasoningEl);
        wrap.appendChild(body);
        log.appendChild(wrap);
        bubbles.set(m.messageId, { el: wrap, body, text: '', reasoningEl, reasoningBody, reasoning: '' });
        break;
      }
      case 'assistantDelta': {
        const b = bubbles.get(m.messageId);
        if (!b) break;
        b.text += m.text;
        b.body.textContent = clean(b.text);
        break;
      }
      case 'reasoningDelta': {
        const b = bubbles.get(m.messageId);
        if (!b) break;
        b.reasoning += m.text;
        b.reasoningEl.hidden = false;
        b.reasoningBody.textContent = b.reasoning;
        break;
      }
      case 'toolCall': {
        if (toolCards.has(m.callId)) break;
        const card = el('details', 'tool');
        const summary = el('summary');
        summary.appendChild(el('span', 'tool-name', '🔧 ' + m.name));
        summary.appendChild(el('span', 'tool-args', ' ' + shortArgs(m.args)));
        card.appendChild(summary);
        card.appendChild(el('pre', 'tool-result pending', 'running…'));
        log.appendChild(card);
        toolCards.set(m.callId, card);
        break;
      }
      case 'toolResult': {
        let card = toolCards.get(m.callId);
        if (!card) {
          card = el('details', 'tool');
          const summary = el('summary');
          summary.appendChild(el('span', 'tool-name', '🔧 ' + m.name));
          card.appendChild(summary);
          card.appendChild(el('pre', 'tool-result'));
          log.appendChild(card);
          toolCards.set(m.callId, card);
        }
        const pre = card.querySelector('pre');
        pre.textContent = m.preview;
        pre.className = 'tool-result' + (m.isError ? ' error' : '');
        if (m.isError) card.classList.add('error');
        break;
      }
      case 'review':
        renderReview(m);
        break;
      case 'approval':
        renderApproval(m);
        break;
      case 'applied':
        renderApplied(m);
        break;
      case 'reverted':
        renderReverted(m);
        break;
      case 'status':
        setStatus(m.kind, m.text);
        if (m.kind === 'error') log.appendChild(el('div', 'msg error', m.text));
        break;
      case 'busy':
        setBusy(m.busy);
        break;
      case 'session':
        modelEl.textContent = 'model: ' + (m.model || '—');
        openBtn.disabled = !m.url;
        if (!m.id) {
          log.textContent = '';
          bubbles.clear();
          toolCards.clear();
          reviewCards.clear();
          approvalCards.clear();
          appliedCards.clear();
          log.appendChild(el('div', 'hint', 'New session. Ask anything about the open repository.'));
          setStatus('info', '');
        }
        break;
    }
    scrollDown();
  });

  function shortArgs(args) {
    try {
      const obj = JSON.parse(args || '{}');
      const parts = Object.entries(obj).map(([k, v]) => k + '=' + JSON.stringify(v));
      const s = parts.join(', ');
      return '(' + (s.length > 120 ? s.slice(0, 117) + '…' : s) + ')';
    } catch {
      return args ? '(' + args.slice(0, 120) + ')' : '()';
    }
  }

  vscode.postMessage({ type: 'ready' });
})();
