/**
 * Forge Agent — a VS Code coding agent whose agent loop runs on TrueForge.
 *
 * On activation: start the editor MCP server (127.0.0.1, bearer token), register it in TrueForge,
 * and provide the agent panel. Each panel conversation is a TrueForge session; TrueForge runs the
 * loop and calls back into the editor through MCP.
 */
import * as vscode from 'vscode';
import { AgentSession, trueforgeUrl } from './agent/agentSession';
import { startEditorMcpServer, type EditorMcpEndpoint } from './mcp/editorServer';
import { errorMessage, TrueForgeClient } from './trueforge/client';
import { AgentPanelProvider } from './ui/agentPanel';

let mcpEndpoint: EditorMcpEndpoint | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Forge Agent');
  context.subscriptions.push(output);
  const log = (msg: string): void => output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

  const client = new TrueForgeClient(trueforgeUrl);
  let session: AgentSession | undefined;

  let ready = false; // the panel may resolve before activation finishes; announce() waits for this
  const panel = new AgentPanelProvider(context.extensionUri, {
    send: text => void session?.send(text),
    stop: () => void session?.stop(),
    newSession: () => void session?.reset(),
    openSession: () => openSessionInTrueForge(),
    ready: () => {
      if (ready) {
        void announce();
      }
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  try {
    mcpEndpoint = await startEditorMcpServer(log);
  } catch (err) {
    const msg = `Forge Agent could not start its editor MCP server: ${errorMessage(err)}`;
    log(msg);
    panel.post({ type: 'status', kind: 'error', text: msg });
    void vscode.window.showErrorMessage(msg);
    return;
  }
  const endpoint = mcpEndpoint;
  session = new AgentSession(client, endpoint, context.extensionPath, msg => panel.post(msg), log);
  const agent = session;
  ready = true;

  /** Health check + MCP registration, reported in the panel. Safe to call any time. */
  async function announce(): Promise<void> {
    let model = '—';
    try {
      model = agent.loadSpec().model.name;
    } catch (err) {
      panel.post({ type: 'status', kind: 'error', text: `Agent definition: ${errorMessage(err)}` });
    }
    panel.post({ type: 'session', id: agent.currentSessionId, url: agent.sessionUrl(), model });
    try {
      const health = await client.health();
      await agent.registerMcpServer();
      log(`TrueForge ${health.version ?? ''} at ${trueforgeUrl()} — editor MCP server registered`);
      if (!agent.isBusy) {
        panel.post({ type: 'status', kind: 'ok', text: `Connected to TrueForge ${health.version ?? ''}.` });
      }
    } catch (err) {
      log(`TrueForge not reachable yet: ${errorMessage(err)}`);
      panel.post({ type: 'status', kind: 'error', text: errorMessage(err) });
    }
  }

  function openSessionInTrueForge(): void {
    const url = agent.sessionUrl();
    if (url) {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    } else {
      void vscode.window.showInformationMessage('No session yet — send a message in the Forge Agent panel first.');
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('forgeAgent.newSession', () => agent.reset()),
    vscode.commands.registerCommand('forgeAgent.stop', () => agent.stop()),
    vscode.commands.registerCommand('forgeAgent.openSessionInTrueForge', openSessionInTrueForge),
    vscode.commands.registerCommand('forgeAgent.reconnect', () => announce()),
    vscode.commands.registerCommand('forgeAgent.showLog', () => output.show()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('forgeAgent')) {
        void announce();
      }
    }),
    { dispose: () => void endpoint.dispose() },
  );

  void announce();
}

export async function deactivate(): Promise<void> {
  await mcpEndpoint?.dispose();
}
