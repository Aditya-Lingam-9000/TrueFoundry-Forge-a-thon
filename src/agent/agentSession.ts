/**
 * One agent conversation = one TrueForge session. Sends turns, translates TrueForge's streamed
 * events into panel updates, and cancels on Stop. The agent loop itself runs inside TrueForge.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EditorMcpEndpoint } from '../mcp/editorServer';
import { errorMessage, TrueForgeClient, type ToolCallDelta, type TurnEvent } from '../trueforge/client';

/** Messages the extension sends to the panel webview. */
export type PanelMessage =
  | { type: 'user'; text: string }
  | { type: 'assistantStart'; messageId: string }
  | { type: 'assistantDelta'; messageId: string; text: string }
  | { type: 'reasoningDelta'; messageId: string; text: string }
  | { type: 'toolCall'; callId: string; name: string; args: string }
  | { type: 'toolResult'; callId: string; name: string; preview: string; isError: boolean }
  | { type: 'status'; kind: 'info' | 'ok' | 'error'; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'session'; id: string | null; url: string | null; model: string };

interface AgentSpec {
  model: { name: string; params?: Record<string, unknown> };
  mcp_servers?: { name: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

interface ToolCallState {
  id: string;
  name: string;
  args: string;
  announced: boolean;
}

export class AgentSession {
  private sessionId: string | null = null;
  private controller: AbortController | null = null;
  private busy = false;

  constructor(
    private readonly client: TrueForgeClient,
    private readonly mcp: EditorMcpEndpoint,
    private readonly extensionPath: string,
    private readonly post: (msg: PanelMessage) => void,
    private readonly log: (msg: string) => void,
  ) {}

  get isBusy(): boolean {
    return this.busy;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  sessionUrl(): string | null {
    return this.sessionId ? `${trueforgeUrl()}/sessions/${this.sessionId}` : null;
  }

  /** Forget the current session; the next message starts a new one. */
  async reset(): Promise<void> {
    await this.stop();
    this.sessionId = null;
    this.post({ type: 'session', id: null, url: null, model: this.loadSpec().model.name });
  }

  /** Abort the stream and cancel the turn inside TrueForge. */
  async stop(): Promise<void> {
    if (!this.busy) {
      return;
    }
    this.controller?.abort();
    if (this.sessionId) {
      try {
        await this.client.cancel(this.sessionId);
        this.log(`cancelled session ${this.sessionId}`);
      } catch (err) {
        this.log(`cancel failed: ${errorMessage(err)}`);
      }
    }
  }

  /** Register (or refresh) the editor MCP server in TrueForge. Cheap and idempotent. */
  async registerMcpServer(): Promise<void> {
    await this.client.putMcpServer({
      type: 'remote',
      name: mcpServerName(),
      url: this.mcp.url,
      description:
        'The VS Code workspace the user has open: list files, read files with line numbers, search code.',
      auth: { type: 'header', headers: { Authorization: `Bearer ${this.mcp.token}` } },
    });
  }

  loadSpec(): AgentSpec {
    const configured = vscode.workspace.getConfiguration('forgeAgent').get<string>('agentDefinition', '').trim();
    const file = configured || path.join(this.extensionPath, 'agent', 'forge-agent.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentSpec;
    const model = vscode.workspace.getConfiguration('forgeAgent').get<string>('model', '').trim();
    if (model) {
      spec.model = { ...spec.model, name: model };
    }
    // Point the agent at this extension's MCP server under its configured name.
    const name = mcpServerName();
    spec.mcp_servers = (spec.mcp_servers ?? []).map(s => (s.name === 'forge-editor' ? { ...s, name } : s));
    if (!spec.mcp_servers.some(s => s.name === name)) {
      spec.mcp_servers.push({ name, enable_tools: ['@all'], preload: true });
    }
    return spec;
  }

  async send(text: string): Promise<void> {
    if (this.busy) {
      this.post({ type: 'status', kind: 'info', text: 'The agent is still working — press Stop first.' });
      return;
    }
    this.busy = true;
    this.post({ type: 'busy', busy: true });
    this.post({ type: 'user', text });
    const controller = new AbortController();
    this.controller = controller;
    const started = Date.now();
    try {
      await this.registerMcpServer();
      if (!this.sessionId) {
        const spec = this.loadSpec();
        this.sessionId = await this.client.createSession(spec, {
          'tfg.source': 'ui',
          client: 'forge-agent-vscode',
        });
        this.log(`created session ${this.sessionId} with model ${spec.model.name}`);
        this.post({ type: 'session', id: this.sessionId, url: this.sessionUrl(), model: spec.model.name });
      }
      await this.consume(this.client.streamTurn(this.sessionId, text, controller.signal), started);
      if (controller.signal.aborted) {
        this.post({ type: 'status', kind: 'info', text: 'Stopped. Nothing was changed.' });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        this.post({ type: 'status', kind: 'info', text: 'Stopped.' });
      } else {
        this.log(`turn failed: ${errorMessage(err)}`);
        this.post({ type: 'status', kind: 'error', text: errorMessage(err) });
      }
    } finally {
      this.busy = false;
      this.controller = null;
      this.post({ type: 'busy', busy: false });
    }
  }

  private async consume(events: AsyncGenerator<TurnEvent>, started: number): Promise<void> {
    const streamedMessages = new Set<string>();
    const toolCalls = new Map<string, ToolCallState>(); // key: `${messageId}:${index}`
    const callsById = new Map<string, ToolCallState>();
    let sawDone = false;

    const flushCalls = (messageId: string): void => {
      for (const [key, call] of toolCalls) {
        if (key.startsWith(`${messageId}:`) && call.id) {
          callsById.set(call.id, call);
          this.post({ type: 'toolCall', callId: call.id, name: call.name, args: call.args });
        }
      }
    };

    for await (const ev of events) {
      const thread = ev.thread_id;
      switch (ev.type) {
        case 'model.message': {
          if (thread !== 'main' || !ev.id) {
            break;
          }
          if (!streamedMessages.has(ev.id)) {
            // Base event (empty) before the deltas — or a complete message from a non-streaming path.
            this.post({ type: 'assistantStart', messageId: ev.id });
            const content = typeof ev.content === 'string' ? ev.content : '';
            if (content) {
              this.post({ type: 'assistantDelta', messageId: ev.id, text: content });
            }
            const calls = Array.isArray(ev.tool_calls) ? (ev.tool_calls as ToolCallDelta[]) : [];
            calls.forEach((c, i) => {
              const key = `${ev.id}:${c.index ?? i}`;
              if (!toolCalls.has(key)) {
                toolCalls.set(key, {
                  id: c.id ?? '',
                  name: c.function?.name ?? '',
                  args: c.function?.arguments ?? '',
                  announced: false,
                });
              }
            });
            if (calls.length) {
              flushCalls(ev.id);
            }
            streamedMessages.add(ev.id);
          }
          break;
        }
        case 'model.message.delta': {
          if (thread !== 'main' || !ev.id) {
            break;
          }
          if (!streamedMessages.has(ev.id)) {
            streamedMessages.add(ev.id);
            this.post({ type: 'assistantStart', messageId: ev.id });
          }
          if (typeof ev.reasoning_content === 'string' && ev.reasoning_content) {
            this.post({ type: 'reasoningDelta', messageId: ev.id, text: ev.reasoning_content });
          }
          if (typeof ev.content === 'string' && ev.content) {
            this.post({ type: 'assistantDelta', messageId: ev.id, text: ev.content });
          }
          if (Array.isArray(ev.tool_calls)) {
            (ev.tool_calls as ToolCallDelta[]).forEach((c, i) => {
              const key = `${ev.id}:${c.index ?? i}`;
              const call = toolCalls.get(key) ?? { id: '', name: '', args: '', announced: false };
              if (c.id) {
                call.id = c.id;
              }
              if (c.function?.name) {
                call.name += c.function.name;
              }
              if (c.function?.arguments) {
                call.args += c.function.arguments;
              }
              toolCalls.set(key, call);
            });
          }
          if (ev.finish_reason) {
            flushCalls(ev.id);
          }
          break;
        }
        case 'tool.response': {
          const callId = typeof ev.tool_call_id === 'string' ? ev.tool_call_id : '';
          if (thread !== 'main') {
            break;
          }
          const call = callsById.get(callId);
          const content = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content ?? '');
          this.post({
            type: 'toolResult',
            callId,
            name: call?.name ?? 'tool',
            preview: content.length > 1200 ? `${content.slice(0, 1200)}\n… (${content.length} characters)` : content,
            isError: /^Error:/.test(content),
          });
          break;
        }
        case 'tool.approval_required': {
          this.post({
            type: 'status',
            kind: 'info',
            text: 'TrueForge is waiting for a tool approval — approvals arrive in the next milestone (diff review).',
          });
          break;
        }
        case 'thread.context_compaction_started': {
          this.post({ type: 'status', kind: 'info', text: 'TrueForge is compacting the conversation context…' });
          break;
        }
        case 'turn.done': {
          sawDone = true;
          const state = (ev.state ?? {}) as { status?: string; message?: string; reason?: string };
          const secs = ((Date.now() - started) / 1000).toFixed(1);
          if (state.status === 'done') {
            this.post({ type: 'status', kind: 'ok', text: `Done in ${secs} s.` });
          } else if (state.status === 'cancelled') {
            this.post({ type: 'status', kind: 'info', text: `Cancelled (${state.reason ?? 'cancelled'}).` });
          } else if (state.status === 'error') {
            this.post({ type: 'status', kind: 'error', text: `The model call failed: ${state.message ?? 'unknown error'}` });
          }
          break;
        }
        default:
          break;
      }
    }
    if (!sawDone) {
      this.log('stream ended without turn.done');
    }
  }
}

export function trueforgeUrl(): string {
  return vscode.workspace
    .getConfiguration('forgeAgent')
    .get<string>('trueforgeUrl', 'http://localhost:8790')
    .replace(/\/+$/, '');
}

export function mcpServerName(): string {
  return vscode.workspace.getConfiguration('forgeAgent').get<string>('mcpServerName', 'forge-editor');
}
