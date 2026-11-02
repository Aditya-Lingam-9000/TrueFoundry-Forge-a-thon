/**
 * Forge Agent — a VS Code coding agent whose agent loop runs on TrueForge.
 *
 * On activation: start the editor MCP server (127.0.0.1, bearer token), register it in TrueForge,
 * and provide the agent panel and the hunk-by-hunk review. Each panel conversation is a TrueForge
 * session; TrueForge runs the loop, calls back into the editor through MCP, and pauses for the
 * user's approval before any write or command.
 */
import * as vscode from 'vscode';
import { AgentSession, trueforgeUrl, type PanelMessage } from './agent/agentSession';
import { registerInlineEdit } from './inline/inlineEdit';
import { CommandRunner } from './mcp/commandRunner';
import { startEditorMcpServer, type EditorMcpEndpoint } from './mcp/editorServer';
import { ChangeController } from './review/changeController';
import { ReviewManager } from './review/reviewManager';
import { errorMessage, TrueForgeClient } from './trueforge/client';
import { AgentPanelProvider } from './ui/agentPanel';

let mcpEndpoint: EditorMcpEndpoint | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Forge Agent');
  const commandOutput = vscode.window.createOutputChannel('Forge Agent: Commands');
  context.subscriptions.push(output, commandOutput);
  const log = (msg: string): void => output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

  const client = new TrueForgeClient(trueforgeUrl);
  let session: AgentSession | undefined;
  let inlineSession: AgentSession | undefined;
  let ready = false; // the panel may resolve before activation finishes; announce() waits for this

  const panel = new AgentPanelProvider(context.extensionUri, {
    send: text => void session?.send(text),
    stop: () => {
      void session?.stop();
      void inlineSession?.stop();
    },
    newSession: () => void session?.reset(),
    openSession: () => openSessionInTrueForge(),
    approve: (callId, allow) => {
      session?.answerApproval(callId, allow);
      inlineSession?.answerApproval(callId, allow);
    },
    openReview: callId => void reviews.open(callId),
    revert: changeId => void revert(changeId),
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

  const reviews = new ReviewManager();
  reviews.register(context);
  const changes = new ChangeController(e => {
    if (e.type === 'applied') {
      const c = e.change;
      panel.post({
        type: 'applied',
        changeId: c.id,
        path: c.rel,
        summary:
          `${c.acceptedHunks}/${c.totalHunks} hunk(s) written (+${c.added} −${c.removed})` +
          (c.before === null ? ' · new file' : '') +
          ' · Cmd/Ctrl+Z in the file or "Revert this change" undoes it',
      });
    } else {
      panel.post({ type: 'reverted', changeId: e.change.id, path: e.change.rel });
    }
  }, log);
  const commands = new CommandRunner(commandOutput);

  try {
    mcpEndpoint = await startEditorMcpServer({ log, changes, commands });
  } catch (err) {
    const msg = `Forge Agent could not start its editor MCP server: ${errorMessage(err)}`;
    log(msg);
    panel.post({ type: 'status', kind: 'error', text: msg });
    void vscode.window.showErrorMessage(msg);
    return;
  }
  const endpoint = mcpEndpoint;
  const shared = { client, mcp: endpoint, reviews, changes, commands, extensionPath: context.extensionPath, log };
  // "Open in TrueForge" opens whichever session (chat or inline edit) ran last.
  let lastSessionUrl: string | null = null;
  const remember = (msg: PanelMessage): void => {
    if (msg.type === 'session') {
      lastSessionUrl = msg.url ?? lastSessionUrl;
    }
  };
  session = new AgentSession({
    ...shared,
    post: msg => {
      remember(msg);
      panel.post(msg);
    },
    isOtherBusy: () => inlineSession?.isBusy ?? false,
  });
  // Inline edits: a fresh lean session per edit, reviews open beside the edited file.
  let inlineSink: ((msg: PanelMessage) => void) | undefined;
  inlineSession = new AgentSession({
    ...shared,
    post: msg => {
      remember(msg);
      panel.post(msg);
      inlineSink?.(msg);
    },
    spec: { setting: 'inlineAgentDefinition', bundled: 'inline-edit.json' },
    oneShot: true,
    reviewColumn: vscode.ViewColumn.Beside,
    isOtherBusy: () => session?.isBusy ?? false,
  });
  registerInlineEdit(context, {
    session: inlineSession,
    log,
    setProgressSink: sink => {
      inlineSink = sink;
    },
  });
  const agent = session;
  const inlineAgent = inlineSession;
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

  async function revert(changeId?: string): Promise<void> {
    const msg = await changes.revert(changeId);
    log(msg);
    void vscode.window.showInformationMessage(msg);
  }

  function openSessionInTrueForge(): void {
    const url = lastSessionUrl ?? agent.sessionUrl();
    if (url) {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    } else {
      void vscode.window.showInformationMessage('No session yet — send a message in the Forge Agent panel first.');
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('forgeAgent.newSession', () => agent.reset()),
    vscode.commands.registerCommand('forgeAgent.stop', () => Promise.all([agent.stop(), inlineAgent.stop()])),
    vscode.commands.registerCommand('forgeAgent.openSessionInTrueForge', openSessionInTrueForge),
    vscode.commands.registerCommand('forgeAgent.revertLastChange', () => revert()),
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
