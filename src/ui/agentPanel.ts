/**
 * The agent panel (a webview view in the Forge Agent activity-bar container).
 * Webview → extension: FromWebview below. Extension → webview: PanelMessage (see agentSession.ts).
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { PanelMessage } from '../agent/agentSession';

type FromWebview =
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'newSession' }
  | { type: 'openSession' }
  | { type: 'approve'; callId: string; allow: boolean }
  | { type: 'openReview'; callId: string }
  | { type: 'revert'; changeId: string }
  | { type: 'ready' };

export interface PanelHandlers {
  send(text: string): void;
  stop(): void;
  newSession(): void;
  openSession(): void;
  approve(callId: string, allow: boolean): void;
  openReview(callId: string): void;
  revert(changeId: string): void;
  ready(): void;
}

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'forgeAgent.panel';
  private view: vscode.WebviewView | undefined;
  private backlog: PanelMessage[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: PanelHandlers,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((msg: FromWebview) => {
      switch (msg.type) {
        case 'send':
          if (msg.text.trim()) {
            this.handlers.send(msg.text.trim());
          }
          break;
        case 'stop':
          this.handlers.stop();
          break;
        case 'newSession':
          this.handlers.newSession();
          break;
        case 'openSession':
          this.handlers.openSession();
          break;
        case 'approve':
          this.handlers.approve(msg.callId, msg.allow);
          break;
        case 'openReview':
          this.handlers.openReview(msg.callId);
          break;
        case 'revert':
          this.handlers.revert(msg.changeId);
          break;
        case 'ready': {
          const pending = this.backlog;
          this.backlog = [];
          for (const m of pending) {
            void view.webview.postMessage(m);
          }
          this.handlers.ready();
          break;
        }
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  post(msg: PanelMessage): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    } else {
      this.backlog.push(msg);
      if (this.backlog.length > 500) {
        this.backlog.splice(0, this.backlog.length - 500);
      }
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Forge Agent</title>
</head>
<body>
  <header>
    <span id="model" class="muted">model: —</span>
    <span class="spacer"></span>
    <button id="open" class="link" title="Open this session in the TrueForge UI" disabled>Open in TrueForge</button>
    <button id="new" class="link" title="Start a new session">New</button>
  </header>
  <main id="log" aria-live="polite">
    <div class="hint">Ask about the open repository or ask for a change, e.g. <em>Where is get_debug_flag defined?</em>
    The agent runs on TrueForge. Every edit is shown to you hunk by hunk before anything is written,
    and every command needs your approval.</div>
  </main>
  <footer>
    <div id="status" class="muted"></div>
    <textarea id="input" rows="3" placeholder="Ask the agent… (Enter to send, Shift+Enter for a new line)"></textarea>
    <div class="row">
      <span class="spacer"></span>
      <button id="stop" class="secondary" disabled>Stop</button>
      <button id="send">Send</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
