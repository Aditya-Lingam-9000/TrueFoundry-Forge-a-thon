/**
 * One agent conversation = one TrueForge session. Sends turns, translates TrueForge's streamed
 * events into panel updates, and turns TrueForge tool approvals into editor reviews:
 *
 *   model calls propose_write / run_command
 *     → TrueForge pauses the turn (tool.approval_required)
 *     → propose_write: hunk-by-hunk review in the editor; run_command: Allow/Deny in the panel
 *     → every decision goes back to TrueForge in one batch (user.tool_approval)
 *     → TrueForge runs the approved tools (our MCP server writes only the accepted hunks) and the
 *       loop continues.
 *
 * The agent loop itself runs inside TrueForge.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveMentions } from '../context/mentions';
import { renderPlan, type ContextPlan } from '../context/rank';
import { retrieveContext } from '../context/retrieve';
import { guardCommand } from '../mcp/checkOnly';
import { workspaceRoot } from '../mcp/workspace';
import { doneCheckMessage, findGaps, type RepoFacts, type WorkStep } from './doneCheck';
import { isModelFailure, modelChain, nextAction, shortReason } from './fallback';
import { scoutKickoff } from './kickoff';
import type { EditorMcpEndpoint } from '../mcp/editorServer';
import type { CommandRunner } from '../mcp/commandRunner';
import type { ChangeController } from '../review/changeController';
import { computeHunks } from '../review/diff';
import { assertWithinSelection } from '../review/edits';
import {
  buildProposal,
  buildSelectionProposal,
  parseProposeArgs,
  type Proposal,
  type ProposeWriteArgs,
  type SelectionScope,
} from '../review/proposal';
import type { ReviewManager } from '../review/reviewManager';
import { errorMessage, TrueForgeClient, type ToolCallDelta, type TurnEvent, type TurnInput } from '../trueforge/client';

export type ReviewState = 'pending' | 'accepted' | 'partial' | 'rejected' | 'invalid' | 'cancelled' | 'merged';
export type ApprovalState = 'pending' | 'allowed' | 'denied' | 'cancelled';

/** Messages the extension sends to the panel webview. */
export type PanelMessage =
  | { type: 'user'; text: string }
  | { type: 'assistantStart'; messageId: string }
  | { type: 'assistantDelta'; messageId: string; text: string }
  | { type: 'reasoningDelta'; messageId: string; text: string }
  | { type: 'toolCall'; callId: string; name: string; args: string }
  | { type: 'toolResult'; callId: string; name: string; preview: string; isError: boolean }
  | {
      type: 'review';
      callId: string;
      path: string;
      hunks: number;
      added: number;
      removed: number;
      state: ReviewState;
      detail?: string;
    }
  | { type: 'approval'; callId: string; title: string; detail: string; state: ApprovalState }
  | { type: 'doneCheck'; items: string[] }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | {
      type: 'contextPlan';
      /** true: retrieved by the editor from the user's message; false: the agent called retrieve_context */
      auto: boolean;
      query: string;
      budget: number;
      used: number;
      considered: number;
      /** sibling patterns the retrieval followed, as sentences */
      patterns: string[];
      items: { path: string; lines: string; name: string; tokens: number; reasons: string }[];
    }
  | {
      type: 'mentions';
      items: { token: string; kind: 'file' | 'symbol'; resolved: boolean; where?: string; note?: string }[];
    }
  | {
      type: 'subagent';
      threadId: string;
      name: string;
      task: string;
      state: 'running' | 'done' | 'error';
      tools: number;
      lastTool?: string;
      result?: string;
    }
  | { type: 'applied'; changeId: string; path: string; summary: string }
  | { type: 'reverted'; changeId: string; path: string }
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
}

interface ApprovalRef {
  threadId: string;
  callId: string;
  sourceEventId: string;
}

const GATED_TOOLS = ['propose_write', 'run_command'];

export interface AgentSessionDeps {
  client: TrueForgeClient;
  mcp: EditorMcpEndpoint;
  reviews: ReviewManager;
  changes: ChangeController;
  commands: CommandRunner;
  extensionPath: string;
  post: (msg: PanelMessage) => void;
  log: (msg: string) => void;
  /** agent definition to use: a path, or a setting name holding a path, with a bundled default */
  spec?: { setting: string; bundled: string };
  /** start a fresh TrueForge session for every message (inline edits) */
  oneShot?: boolean;
  /** where reviews open (inline edits open beside the edited file) */
  reviewColumn?: vscode.ViewColumn;
  /** another agent session that must not run at the same time */
  isOtherBusy?: () => boolean;
  /** resolve @-mentions and attach automatically retrieved context to every user message */
  autoContext?: boolean;
}

/** A context plan as a panel card. */
export function planMessage(plan: ContextPlan, auto: boolean): PanelMessage {
  return {
    type: 'contextPlan',
    auto,
    query: plan.query,
    budget: plan.budget,
    used: plan.used,
    considered: plan.filesConsidered,
    patterns: plan.patterns,
    items: plan.items.map(it => ({
      path: it.path,
      lines: `${it.startLine}-${it.endLine}`,
      name: it.name,
      tokens: it.tokens,
      reasons: it.reasons.join('; '),
    })),
  };
}

/** How a send() ended. */
export interface TurnOutcome {
  status: 'done' | 'error' | 'stopped' | 'busy';
  message?: string;
}

export interface SendOptions {
  /** text shown in the panel instead of the full prompt */
  display?: string;
  /** inline edit: only these lines of this file may change */
  scope?: SelectionScope;
  /** title of the review document */
  reviewTitle?: string;
}

export class AgentSession {
  private sessionId: string | null = null;
  private controller: AbortController | null = null;
  private busy = false;
  /** tool calls seen in the current send, by tool_call_id (needed to answer approvals) */
  private callsById = new Map<string, ToolCallState>();
  /** pending Allow/Deny questions in the panel */
  private readonly panelApprovals = new Map<string, (allow: boolean | null) => void>();
  /** options of the message being processed */
  private sendOptions: SendOptions = {};
  /** how the current send ended (set from turn.done) */
  private outcome: TurnOutcome = { status: 'done' };
  /** reviewed writes and approved commands of the current send, in order (for the done-check) */
  private steps: WorkStep[] = [];
  /** model the current session runs on (it changes when the editor falls back to another model) */
  private model: string | null = null;
  /** last turn of the session that did not fail: a retried request is chained to it */
  private lastGoodTurnId: string | undefined;

  constructor(private readonly d: AgentSessionDeps) {}

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
    this.model = null;
    this.d.post({ type: 'session', id: null, url: null, model: this.loadSpec().model.name });
  }

  /** Stop everything: abort the stream, cancel the turn in TrueForge, close reviews, kill commands. */
  async stop(): Promise<void> {
    if (!this.busy) {
      return;
    }
    this.controller?.abort();
    this.d.reviews.cancelAll();
    for (const resolve of this.panelApprovals.values()) {
      resolve(null);
    }
    this.panelApprovals.clear();
    this.d.commands.killAll();
    this.d.changes.forgetApprovals();
    if (this.sessionId) {
      try {
        await this.d.client.cancel(this.sessionId);
        this.d.log(`cancelled session ${this.sessionId}`);
      } catch (err) {
        this.d.log(`cancel failed: ${errorMessage(err)}`);
      }
    }
  }

  /** Answer from the panel's Allow / Deny buttons. */
  answerApproval(callId: string, allow: boolean): void {
    const resolve = this.panelApprovals.get(callId);
    if (resolve) {
      this.panelApprovals.delete(callId);
      resolve(allow);
    }
  }

  /** Register (or refresh) the editor MCP server in TrueForge. Cheap and idempotent. */
  async registerMcpServer(): Promise<void> {
    await this.d.client.putMcpServer({
      type: 'remote',
      name: mcpServerName(),
      url: this.d.mcp.url,
      description:
        'The VS Code workspace the user has open: list, read and search files, propose reviewed edits, run approved commands.',
      auth: { type: 'header', headers: { Authorization: `Bearer ${this.d.mcp.token}` } },
    });
  }

  loadSpec(): AgentSpec {
    const spec0 = this.d.spec ?? { setting: 'agentDefinition', bundled: 'forge-agent.json' };
    const configured = vscode.workspace.getConfiguration('forgeAgent').get<string>(spec0.setting, '').trim();
    const file = configured || path.join(this.d.extensionPath, 'agent', spec0.bundled);
    const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentSpec;
    const model = vscode.workspace.getConfiguration('forgeAgent').get<string>('model', '').trim();
    if (model) {
      spec.model = { ...spec.model, name: model };
    }
    // Point the agent at this extension's MCP server under its configured name; writes and
    // commands always require approval, whatever the agent definition says.
    const name = mcpServerName();
    spec.mcp_servers = (spec.mcp_servers ?? []).map(s => (s.name === 'forge-editor' ? { ...s, name } : s));
    let editor = spec.mcp_servers.find(s => s.name === name);
    if (!editor) {
      editor = { name, enable_tools: ['@all'], preload: true };
      spec.mcp_servers.push(editor);
    }
    const gated = Array.isArray(editor.require_approval_for_tools) ? (editor.require_approval_for_tools as string[]) : [];
    editor.require_approval_for_tools = [...new Set([...gated, ...GATED_TOOLS])];
    return spec;
  }

  async send(text: string, options: SendOptions = {}): Promise<TurnOutcome> {
    if (this.busy || this.d.isOtherBusy?.()) {
      this.d.post({ type: 'status', kind: 'info', text: 'The agent is still working — press Stop first.' });
      return { status: 'busy', message: 'The agent is still working — press Stop first.' };
    }
    this.busy = true;
    this.sendOptions = options;
    this.outcome = { status: 'done' };
    this.d.post({ type: 'busy', busy: true });
    this.d.post({ type: 'user', text: options.display ?? text });
    const controller = new AbortController();
    this.controller = controller;
    this.callsById = new Map();
    this.steps = [];
    const started = Date.now();
    if (this.d.oneShot) {
      this.sessionId = null;
    }
    try {
      await this.registerMcpServer();
      if (!this.sessionId) {
        const spec = await this.fitToModel(this.loadSpec());
        this.sessionId = await this.d.client.createSession(spec, { 'tfg.source': 'ui', client: 'forge-agent-vscode' });
        this.model = spec.model.name;
        this.lastGoodTurnId = undefined;
        this.d.log(`created session ${this.sessionId} with model ${spec.model.name}`);
        this.d.post({ type: 'session', id: this.sessionId, url: this.sessionUrl(), model: spec.model.name });
      }
      const sessionId = this.sessionId;

      const content = this.d.autoContext && !options.scope ? await this.withContext(text) : text;
      let input: TurnInput[] = [{ type: 'user.message', content }];
      let previousTurnId: string | undefined;
      const recovery: Recovery = { tried: new Set(), retried: false, failures: [] };
      // Whether any turn of this request succeeded (then a failure resumes it instead of resending it).
      let progressed = false;
      // Pass 0 is the request; pass 1, if needed, is the done-check follow-up.
      for (let pass = 0; pass < 2; pass++) {
      for (let round = 0; round < 100; round++) {
        const { approvals, turnId } = await this.consume(
          this.d.client.streamTurn(sessionId, input, controller.signal, previousTurnId),
          started,
        );
        previousTurnId = undefined;
        if (this.outcome.status !== 'error' && turnId) {
          this.lastGoodTurnId = turnId;
          progressed = true;
        }
        if (!controller.signal.aborted && approvals.length === 0 && this.outcome.status === 'error') {
          // A failed model call: retry it, or fall back to the next configured model (Task C).
          const next = await this.recover(sessionId, content, progressed, recovery, controller.signal);
          if (next) {
            ({ input, previousTurnId } = next);
            continue;
          }
        }
        if (controller.signal.aborted || approvals.length === 0) {
          break;
        }
        this.d.post({
          type: 'status',
          kind: 'info',
          text: `Waiting for your decision on ${approvals.length} action(s) — review in the editor / panel.`,
        });
        // Approvals are decided in parallel, so several proposals for one file would each be built
        // against the same original. They are merged into one review (the first call's); the
        // others are answered with that, or sent back if their edits cannot be combined.
        const byFile = new Map<string, ApprovalRef[]>();
        for (const ref of approvals) {
          const call = this.callsById.get(ref.callId);
          if (call?.name === 'propose_write') {
            const rel = pathOf(call.args).replace(/^\.\//, '');
            byFile.set(rel, [...(byFile.get(rel) ?? []), ref]);
          }
        }
        const merges = new Map<string, Promise<boolean>>();
        const decisions = await Promise.all(
          approvals.map(async ref => {
            const call = this.callsById.get(ref.callId);
            const rel = call?.name === 'propose_write' ? pathOf(call.args).replace(/^\.\//, '') : undefined;
            const group = rel !== undefined ? (byFile.get(rel) ?? []) : [];
            if (rel === undefined || group.length < 2) {
              return this.decide(sessionId, turnId, ref);
            }
            if (group[0] !== ref) {
              const merged = await (merges.get(rel) ?? Promise.resolve(false));
              return merged ? this.mergedAway(ref, rel) : this.sameFileAgain(ref, rel);
            }
            let done: (merged: boolean) => void = () => {};
            merges.set(rel, new Promise<boolean>(resolve => (done = resolve)));
            const extra = group.slice(1).map(r => this.callsById.get(r.callId)?.args ?? '');
            return this.decide(sessionId, turnId, ref, { extra, done });
          }),
        );
        if (controller.signal.aborted) {
          await this.denyAndCancel(sessionId, approvals);
          break;
        }
        input = decisions;
      }
      const followUp = pass === 0 && !controller.signal.aborted ? this.doneCheck() : undefined;
      if (!followUp) {
        break;
      }
      input = [{ type: 'user.message', content: followUp }];
      }
      if (controller.signal.aborted) {
        this.outcome = { status: 'stopped' };
        this.d.post({ type: 'status', kind: 'info', text: 'Stopped. Nothing unapproved was written.' });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        this.outcome = { status: 'stopped' };
        this.d.post({ type: 'status', kind: 'info', text: 'Stopped.' });
      } else {
        this.outcome = { status: 'error', message: errorMessage(err) };
        this.d.log(`turn failed: ${errorMessage(err)}`);
        this.d.post({ type: 'status', kind: 'error', text: errorMessage(err) });
      }
    } finally {
      this.busy = false;
      this.controller = null;
      this.sendOptions = {};
      this.d.post({ type: 'busy', busy: false });
    }
    return this.outcome;
  }

  /**
   * Cap max_tokens at the output limit the model declares in TrueForge. A fallback model is often
   * a smaller or free-tier model (Groq counts requested output tokens against 8,000 tokens per
   * minute), while a thinking model needs its full budget; each gets its own declared limit.
   */
  private async fitToModel(spec: AgentSpec): Promise<AgentSpec> {
    let limit: number | undefined;
    try {
      limit = await this.d.client.modelOutputLimit(spec.model.name);
    } catch (err) {
      this.d.log(`could not read the output limit of ${spec.model.name}: ${errorMessage(err)}`);
    }
    const params = { ...(spec.model.params ?? {}) };
    if (limit && (typeof params.max_tokens !== 'number' || params.max_tokens > limit)) {
      params.max_tokens = limit;
    }
    return { ...spec, model: { ...spec.model, params } };
  }

  /**
   * After a model failure: retry it once if it looks transient, otherwise switch the session to
   * the next configured model (PATCH of the inline spec) and send the request again. Returns the
   * next turn's input, or undefined when nothing more can be tried (the error then stands, with
   * every model's reason). Nothing is written before review, so the workspace is unchanged.
   */
  private async recover(
    sessionId: string,
    content: string,
    progressed: boolean,
    r: Recovery,
    signal: AbortSignal,
  ): Promise<{ input: TurnInput[]; previousTurnId?: string } | undefined> {
    const message = this.outcome.message ?? '';
    const primary = this.loadSpec().model.name;
    const current = this.model ?? primary;
    const chain = modelChain(primary, fallbackModels());
    r.tried.add(current);
    const action = nextAction(message, current, chain, r.tried, r.retried);
    const reason = shortReason(message);
    if (!r.failures.some(f => f.startsWith(`${current}:`))) {
      r.failures.push(`${current}: ${reason}`);
    }
    this.d.log(`model failure on ${current} (${reason}) -> ${JSON.stringify(action)}`);

    if (action.kind === 'give-up') {
      if (isModelFailure(message)) {
        const text =
          `No model could answer — ${r.failures.join('; ')}. Nothing was written. ` +
          (chain.length > 1
            ? 'Check the providers in TrueForge (Settings → Model providers).'
            : 'Check the provider in TrueForge (Settings → Model providers), or add a second model to forgeAgent.fallbackModels.');
        this.outcome = { status: 'error', message: text };
        this.d.post({ type: 'status', kind: 'error', text });
      }
      return undefined;
    }

    if (action.kind === 'retry') {
      r.retried = true;
      this.d.post({
        type: 'status',
        kind: 'info',
        text: `${current} failed (${reason}); retrying in ${Math.round(action.delayMs / 1000)} s…`,
      });
      await sleep(action.delayMs, signal);
      if (signal.aborted) {
        return undefined;
      }
    } else {
      const base = this.loadSpec();
      const spec = await this.fitToModel({ ...base, model: { ...base.model, name: action.model } });
      try {
        await this.d.client.updateSessionSpec(sessionId, spec);
      } catch (err) {
        this.d.log(`switching the session to ${action.model} failed: ${errorMessage(err)}`);
        return undefined;
      }
      r.retried = false;
      this.model = action.model;
      this.d.post({ type: 'fallback', from: current, to: action.model, reason });
      this.d.post({ type: 'session', id: sessionId, url: this.sessionUrl(), model: action.model });
      void vscode.window.showWarningMessage(
        `Forge Agent: ${current} failed (${reason}). Switched to ${action.model} automatically.`,
      );
    }

    this.outcome = { status: 'done' };
    if (!progressed) {
      // Nothing happened yet: send the same request again, chained past the failed turn.
      return { input: [{ type: 'user.message', content }], previousTurnId: this.lastGoodTurnId ?? 'none' };
    }
    return {
      input: [
        {
          type: 'user.message',
          content:
            `The previous model call failed (${reason}); you now run on ${this.model ?? current}. ` +
            'Continue the task from where it stopped. Changes reported as applied in earlier tool results are already in the files.',
        },
      ],
    };
  }

  /**
   * After a chat request that changed source files: what a complete change still lacks (tests,
   * checks after the last write, docs, changelog). Returns the follow-up message, or undefined.
   */
  private doneCheck(): string | undefined {
    if (!this.d.autoContext || this.sendOptions.scope || this.outcome.status !== 'done') {
      return undefined;
    }
    let gaps: string[];
    try {
      gaps = findGaps(this.steps, repoFacts());
    } catch (err) {
      this.d.log(`done-check failed: ${errorMessage(err)}`);
      return undefined;
    }
    if (gaps.length === 0) {
      return undefined;
    }
    this.d.log(`done-check: ${gaps.length} gap(s)\n  ${gaps.join('\n  ')}`);
    this.d.post({ type: 'doneCheck', items: gaps });
    return doneCheckMessage(gaps);
  }

  /**
   * The proposal of the first propose_write for a file with the edits of the batch's other calls for
   * that file appended (applied in order to the same original), or undefined if they cannot be
   * combined (a full-content write, or an edit that no longer matches).
   */
  private async mergedProposal(
    args: ProposeWriteArgs,
    extra: string[],
    setMerged: (merged: boolean) => void,
  ): Promise<Proposal | undefined> {
    try {
      const others = extra.map(a => parseProposeArgs(a));
      if (args.content !== undefined || !args.edits?.length || others.some(o => o.content !== undefined || !o.edits?.length)) {
        return undefined;
      }
      const proposal = await buildProposal({ ...args, edits: [...args.edits, ...others.flatMap(o => o.edits ?? [])] });
      setMerged(true);
      return proposal;
    } catch (err) {
      this.d.log(`same-file proposals not merged: ${errorMessage(err)}`);
      return undefined;
    }
  }

  /** A later propose_write for a file whose edits went into the first call's review. */
  private mergedAway(ref: ApprovalRef, rel: string): TurnInput {
    const reason =
      `This change was merged into the review of the first propose_write for ${rel} in this message: the user ` +
      `reviewed all changes to ${rel} together, and that call's result says which hunks were applied. ` +
      'Do not propose this change again.';
    this.d.post({ type: 'review', callId: ref.callId, path: rel, hunks: 0, added: 0, removed: 0, state: 'merged' });
    return { type: 'user.tool_approval', thread_id: ref.threadId, tool_call_id: ref.callId, approval: { status: 'deny', reason } };
  }

  /** A second propose_write for a file in the same batch: not reviewed, sent back with the reason. */
  private sameFileAgain(ref: ApprovalRef, rel: string): TurnInput {
    const reason =
      `Another propose_write for ${rel} is in the same message, and the user reviews one change per file at a time. ` +
      'That other change is being reviewed now. After its result, read the file again and propose this change ' +
      '(combine several changes to one file in a single call with edits). Nothing was written by this call.';
    this.d.post({ type: 'review', callId: ref.callId, path: rel, hunks: 0, added: 0, removed: 0, state: 'invalid', detail: reason });
    return { type: 'user.tool_approval', thread_id: ref.threadId, tool_call_id: ref.callId, approval: { status: 'deny', reason } };
  }

  /** Decide one pending approval → the user.tool_approval item for TrueForge. */
  private async decide(
    sessionId: string,
    turnId: string | undefined,
    ref: ApprovalRef,
    merge?: { extra: string[]; done: (merged: boolean) => void },
  ): Promise<TurnInput> {
    let merged = false;
    try {
      return await this.decideOne(sessionId, turnId, ref, merge, ok => (merged = ok));
    } finally {
      merge?.done(merged);
    }
  }

  private async decideOne(
    sessionId: string,
    turnId: string | undefined,
    ref: ApprovalRef,
    merge: { extra: string[] } | undefined,
    setMerged: (merged: boolean) => void,
  ): Promise<TurnInput> {
    const allow = (): TurnInput => ({
      type: 'user.tool_approval',
      thread_id: ref.threadId,
      tool_call_id: ref.callId,
      approval: { status: 'allow' },
    });
    const deny = (reason: string): TurnInput => ({
      type: 'user.tool_approval',
      thread_id: ref.threadId,
      tool_call_id: ref.callId,
      approval: { status: 'deny', reason },
    });

    const call = this.callsById.get(ref.callId) ?? (await this.lookupCall(sessionId, turnId, ref));
    if (!call) {
      return deny('The editor could not find this tool call, so it was not run. Try again.');
    }

    if (call.name === 'propose_write') {
      let proposal: Proposal;
      let args: ProposeWriteArgs;
      const scope = this.sendOptions.scope;
      try {
        args = parseProposeArgs(call.args);
        if (scope) {
          // Inline edit: anchor to the selected lines, and never let it touch anything else.
          proposal = (await buildSelectionProposal(args, scope)) ?? (await buildProposal(args));
          if (proposal.rel !== scope.rel) {
            throw new Error(`This is an inline edit of ${scope.rel}; do not change other files.`);
          }
          assertWithinSelection(proposal.original, proposal.proposed, scope);
        } else {
          proposal = (merge && (await this.mergedProposal(args, merge.extra, setMerged))) || (await buildProposal(args));
        }
      } catch (err) {
        const reason = errorMessage(err);
        this.d.log(`propose_write sent back: ${reason}\n  arguments: ${call.args.slice(0, 3000)}`);
        this.d.post({
          type: 'review',
          callId: ref.callId,
          path: pathOf(call.args),
          hunks: 0,
          added: 0,
          removed: 0,
          state: 'invalid',
          detail: reason,
        });
        return deny(`The proposed change could not be prepared: ${reason} Nothing was written.`);
      }
      const hunks = computeHunks(proposal.original, proposal.proposed);
      const summary = {
        type: 'review' as const,
        callId: ref.callId,
        path: proposal.rel,
        hunks: hunks.length,
        added: hunks.reduce((n, h) => n + h.added, 0),
        removed: hunks.reduce((n, h) => n + h.removed, 0),
      };
      this.d.post({ ...summary, state: 'pending', detail: proposal.description || undefined });
      const accepted = await this.d.reviews.start(ref.callId, proposal, hunks, {
        column: this.d.reviewColumn,
        title: this.sendOptions.reviewTitle,
      });
      if (accepted === null) {
        this.d.post({ ...summary, state: 'cancelled' });
        return deny('The user stopped the run before reviewing this change. Nothing was written.');
      }
      const n = accepted.filter(Boolean).length;
      if (n === 0) {
        this.d.post({ ...summary, state: 'rejected' });
        return deny(
          `The user rejected every hunk of the proposed change to ${proposal.rel}. Nothing was written. ` +
            'Do not propose the same change again: briefly say what you wanted to change and ask the user how to proceed.',
        );
      }
      this.d.changes.recordApproval(args, proposal, hunks, accepted);
      this.steps.push({ kind: 'write', path: proposal.rel });
      this.d.post({ ...summary, state: n === hunks.length ? 'accepted' : 'partial', detail: `${n}/${hunks.length} hunks accepted` });
      return allow();
    }

    const title = call.name === 'run_command' ? 'Run command' : `Allow tool ${call.name}`;
    const detail = call.name === 'run_command' ? describeCommand(call.args) : call.args.slice(0, 2000);
    this.d.post({ type: 'approval', callId: ref.callId, title, detail, state: 'pending' });
    const answer = await new Promise<boolean | null>(resolve => this.panelApprovals.set(ref.callId, resolve));
    this.d.post({
      type: 'approval',
      callId: ref.callId,
      title,
      detail,
      state: answer === null ? 'cancelled' : answer ? 'allowed' : 'denied',
    });
    if (answer) {
      if (call.name === 'run_command') {
        this.steps.push({ kind: 'command', command: commandOf(call.args) });
      }
      return allow();
    }
    return deny(answer === null ? 'The user stopped the run.' : 'The user denied this action.');
  }

  /**
   * Context assembly for a chat message: explicit @file/@symbol mentions first, then code the
   * editor retrieves automatically for the user's own words, each within its token budget.
   */
  private async withContext(text: string): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('forgeAgent');
    const parts = [text];
    try {
      const m = await resolveMentions(text, cfg.get<number>('mentionBudgetTokens', 3000));
      if (m.mentions.length) {
        this.d.post({ type: 'mentions', items: m.mentions });
      }
      if (m.attachment) {
        parts.push(m.attachment);
      }
    } catch (err) {
      this.d.log(`@-mentions failed: ${errorMessage(err)}`);
    }
    const autoBudget = cfg.get<number>('autoContextTokens', 2500);
    // Short follow-ups ("continue", "yes", "try again") carry no search terms worth ranking.
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    let patterns: string[] = [];
    if (autoBudget > 0 && words >= 3) {
      try {
        this.d.post({ type: 'status', kind: 'info', text: 'Retrieving relevant code for your request…' });
        const plan = await retrieveContext(text, autoBudget);
        patterns = plan.patterns;
        if (plan.items.length) {
          this.d.post(planMessage(plan, true));
          parts.push(
            'Automatically retrieved context for this request (ranked by the editor within a token budget; ' +
              'use it before reading more):\n' +
              renderPlan(plan),
          );
        }
      } catch (err) {
        this.d.log(`automatic retrieval failed: ${errorMessage(err)}`);
      }
    }
    // A multi-file creation request starts with the scout sub-agent (see kickoff.ts).
    const kickoff = scoutKickoff(text, patterns);
    if (kickoff) {
      parts.push(kickoff);
      this.d.post({ type: 'status', kind: 'info', text: 'Multi-file request: the agent is asked to start with a scout sub-agent.' });
    }
    return parts.join('\n\n');
  }

  /** Sub-agents (e.g. the scout): show them starting, their tool calls, and their result. */
  private readonly subagents = new Map<string, { name: string; task: string; calls: Set<string>; lastTool?: string }>();

  private trackSubagent(ev: TurnEvent, threadId: string): void {
    const post = (state: 'running' | 'done' | 'error', result?: string): void => {
      const s = this.subagents.get(threadId);
      if (s) {
        this.d.post({
          type: 'subagent',
          threadId,
          name: s.name,
          task: s.task,
          state,
          tools: s.calls.size,
          lastTool: s.lastTool,
          result,
        });
      }
    };
    if (ev.type === 'thread.created') {
      const info = (ev.agent_info ?? {}) as { name?: string; input?: string };
      const title = typeof ev.title === 'string' ? ev.title : '';
      this.subagents.set(threadId, {
        name: info.name || title || 'sub-agent',
        task: (info.input ?? '').slice(0, 600),
        calls: new Set(),
      });
      post('running');
      return;
    }
    const s = this.subagents.get(threadId);
    if (!s) {
      return;
    }
    if ((ev.type === 'model.message' || ev.type === 'model.message.delta') && Array.isArray(ev.tool_calls)) {
      let changed = false;
      for (const c of ev.tool_calls as ToolCallDelta[]) {
        if (c.id && !s.calls.has(c.id)) {
          s.calls.add(c.id);
          changed = true;
        }
        if (c.function?.name) {
          s.lastTool = c.function.name;
        }
      }
      if (changed) {
        post('running');
      }
    } else if (ev.type === 'thread.done') {
      const state = (ev.state ?? {}) as { status?: string; output?: { content?: unknown }; message?: string };
      const content = typeof state.output?.content === 'string' ? state.output.content : state.message ?? '';
      post(state.status === 'done' ? 'done' : 'error', content.slice(0, 1500));
    }
  }

  /** Fallback: find a tool call's name/arguments in the turn's stored events. */
  private async lookupCall(sessionId: string, turnId: string | undefined, ref: ApprovalRef): Promise<ToolCallState | undefined> {
    if (!turnId) {
      return undefined;
    }
    try {
      const events = await this.d.client.turnEvents(sessionId, turnId);
      const msg = events.find(e => e.id === ref.sourceEventId);
      const raw = msg?.tool_calls;
      const calls = Array.isArray(raw) ? (raw as ToolCallDelta[]) : [];
      const c = calls.find(x => x.id === ref.callId);
      if (c?.function?.name) {
        return { id: ref.callId, name: c.function.name, args: c.function.arguments ?? '' };
      }
    } catch (err) {
      this.d.log(`lookup of tool call ${ref.callId} failed: ${errorMessage(err)}`);
    }
    return undefined;
  }

  /** After Stop during a review: resolve the pending approvals (deny) and cancel right away. */
  private async denyAndCancel(sessionId: string, approvals: ApprovalRef[]): Promise<void> {
    const input = approvals.map(
      (ref): TurnInput => ({
        type: 'user.tool_approval',
        thread_id: ref.threadId,
        tool_call_id: ref.callId,
        approval: { status: 'deny', reason: 'The user stopped the run. Nothing was written.' },
      }),
    );
    const ctl = new AbortController();
    let cancelled = false;
    try {
      for await (const ev of this.d.client.streamTurn(sessionId, input, ctl.signal)) {
        if (!cancelled) {
          cancelled = true;
          await this.d.client.cancel(sessionId).catch(() => undefined);
        }
        if (ev.type === 'turn.done') {
          break;
        }
      }
    } catch (err) {
      this.d.log(`deny-and-cancel: ${errorMessage(err)}`);
    }
  }

  private async consume(
    events: AsyncGenerator<TurnEvent>,
    started: number,
  ): Promise<{ approvals: ApprovalRef[]; turnId: string | undefined }> {
    const streamedMessages = new Set<string>();
    const toolCalls = new Map<string, ToolCallState>(); // key: `${messageId}:${index}`
    const approvals: ApprovalRef[] = [];
    let turnId: string | undefined;
    let sawDone = false;

    const flushCalls = (messageId: string): void => {
      for (const [key, call] of toolCalls) {
        if (key.startsWith(`${messageId}:`) && call.id && !this.callsById.has(call.id)) {
          this.callsById.set(call.id, call);
          this.d.post({ type: 'toolCall', callId: call.id, name: call.name, args: call.args });
        }
      }
    };

    for await (const ev of events) {
      const thread = ev.thread_id;
      if (typeof thread === 'string' && thread !== 'main') {
        this.trackSubagent(ev, thread);
      }
      switch (ev.type) {
        case 'turn.created': {
          if (typeof ev.turn_id === 'string') {
            turnId = ev.turn_id;
          }
          break;
        }
        case 'model.message': {
          if (thread !== 'main' || !ev.id) {
            break;
          }
          const messageId = ev.id;
          if (!streamedMessages.has(messageId)) {
            // Base event (empty) before the deltas — or a complete message from a non-streaming path.
            this.d.post({ type: 'assistantStart', messageId });
            const content = typeof ev.content === 'string' ? ev.content : '';
            if (content) {
              this.d.post({ type: 'assistantDelta', messageId, text: content });
            }
            const calls = Array.isArray(ev.tool_calls) ? (ev.tool_calls as ToolCallDelta[]) : [];
            calls.forEach((c, i) => {
              const key = `${messageId}:${c.index ?? i}`;
              if (!toolCalls.has(key)) {
                toolCalls.set(key, { id: c.id ?? '', name: c.function?.name ?? '', args: c.function?.arguments ?? '' });
              }
            });
            if (calls.length) {
              flushCalls(messageId);
            }
            streamedMessages.add(messageId);
          }
          break;
        }
        case 'model.message.delta': {
          if (thread !== 'main' || !ev.id) {
            break;
          }
          const messageId = ev.id;
          if (!streamedMessages.has(messageId)) {
            streamedMessages.add(messageId);
            this.d.post({ type: 'assistantStart', messageId });
          }
          if (typeof ev.reasoning_content === 'string' && ev.reasoning_content) {
            this.d.post({ type: 'reasoningDelta', messageId, text: ev.reasoning_content });
          }
          if (typeof ev.content === 'string' && ev.content) {
            this.d.post({ type: 'assistantDelta', messageId, text: ev.content });
          }
          if (Array.isArray(ev.tool_calls)) {
            (ev.tool_calls as ToolCallDelta[]).forEach((c, i) => {
              const key = `${messageId}:${c.index ?? i}`;
              const call = toolCalls.get(key) ?? { id: '', name: '', args: '' };
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
            flushCalls(messageId);
          }
          break;
        }
        case 'tool.response': {
          if (thread !== 'main') {
            break;
          }
          const callId = typeof ev.tool_call_id === 'string' ? ev.tool_call_id : '';
          const call = this.callsById.get(callId);
          const { text: content, isError } = readableToolContent(ev.content);
          this.d.post({
            type: 'toolResult',
            callId,
            name: call?.name ?? 'tool',
            preview: content.length > 1200 ? `${content.slice(0, 1200)}\n… (${content.length} characters)` : content,
            isError,
          });
          break;
        }
        case 'tool.approval_required': {
          const refs = Array.isArray(ev.tool_calls) ? (ev.tool_calls as { id?: string; source_event_id?: string }[]) : [];
          for (const r of refs) {
            if (r.id && !approvals.some(a => a.callId === r.id)) {
              approvals.push({
                threadId: typeof thread === 'string' && thread ? thread : 'main',
                callId: r.id,
                sourceEventId: r.source_event_id ?? '',
              });
            }
          }
          break;
        }
        case 'thread.context_compaction_started': {
          this.d.post({ type: 'status', kind: 'info', text: 'TrueForge is compacting the conversation context…' });
          break;
        }
        case 'turn.done': {
          sawDone = true;
          const state = (ev.state ?? {}) as { status?: string; message?: string; reason?: string };
          const secs = ((Date.now() - started) / 1000).toFixed(1);
          if (state.status === 'done' && approvals.length === 0) {
            this.outcome = { status: 'done' };
            this.d.post({ type: 'status', kind: 'ok', text: `Done in ${secs} s.` });
          } else if (state.status === 'cancelled') {
            this.outcome = { status: 'stopped', message: state.reason };
            this.d.post({ type: 'status', kind: 'info', text: `Cancelled (${state.reason ?? 'cancelled'}).` });
          } else if (state.status === 'error') {
            const message = `The model call failed: ${state.message ?? 'unknown error'}`;
            this.outcome = { status: 'error', message };
            this.d.post({ type: 'status', kind: 'error', text: message });
          }
          break;
        }
        default:
          break;
      }
    }
    if (!sawDone) {
      this.d.log('stream ended without turn.done');
    }
    // Calls still unflushed (stream ended without finish_reason) are needed to answer approvals.
    for (const call of toolCalls.values()) {
      if (call.id && !this.callsById.has(call.id)) {
        this.callsById.set(call.id, call);
      }
    }
    return { approvals, turnId };
  }
}

/**
 * TrueForge tool results are plain text, or (for errors and denials) JSON such as
 * {"error":[{"type":"text","text":"{\"error\":\"User denied tool call: …\"}"}]}. Unwrap to text.
 */
function readableToolContent(content: unknown): { text: string; isError: boolean } {
  let text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  let isError = /^Error:/.test(text);
  for (let depth = 0; depth < 3; depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      break;
    }
    if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) {
      break;
    }
    isError = true;
    const err = (parsed as { error: unknown }).error;
    if (typeof err === 'string') {
      text = err;
    } else if (Array.isArray(err)) {
      text = err
        .map(part => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
        .join('\n');
    } else {
      break;
    }
  }
  return { text, isError };
}

function pathOf(args: string): string {
  try {
    const v = JSON.parse(args) as { path?: unknown };
    return typeof v.path === 'string' ? v.path : '(unknown file)';
  } catch {
    return '(unknown file)';
  }
}

/** State of the model-failure handling within one send. */
interface Recovery {
  /** models that failed in this send */
  tried: Set<string>;
  /** the current model already had its retry */
  retried: boolean;
  /** "model: reason" of every failure, for the final message */
  failures: string[];
}

/** Configured fallback models (`<provider>/<model>`), tried in order after the primary. */
function fallbackModels(): string[] {
  const v = vscode.workspace.getConfiguration('forgeAgent').get<unknown>('fallbackModels', []);
  return Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string') : [];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function commandOf(args: string): string {
  try {
    const v = JSON.parse(args) as { command?: unknown };
    return typeof v.command === 'string' ? guardCommand(v.command).command : '';
  } catch {
    return '';
  }
}

/** Facts about the open repository that decide which done-check items apply. */
function repoFacts(): RepoFacts {
  const root = workspaceRoot();
  const rootFiles = fs.readdirSync(root);
  const read = (name: string): string => {
    try {
      return fs.readFileSync(path.join(root, name), 'utf8');
    } catch {
      return '';
    }
  };
  const linterFile = rootFiles.some(f =>
    /^(?:\.pre-commit-config\.ya?ml|ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|\.eslintrc.*|eslint\.config\..*|\.prettierrc.*|biome\.json)$/.test(f),
  );
  const linterConfig =
    /\[tool\.(?:ruff|black|isort|mypy|pylint|flake8)|\[flake8\]/.test(read('pyproject.toml') + read('setup.cfg') + read('tox.ini')) ||
    /"(?:eslint|prettier|@biomejs\/biome)"/.test(read('package.json'));
  return {
    rootFiles,
    hasDocs: rootFiles.includes('docs') || rootFiles.includes('doc'),
    hasLinter: linterFile || linterConfig,
  };
}

function describeCommand(args: string): string {
  try {
    const v = JSON.parse(args) as { command?: unknown; cwd?: unknown; timeout_seconds?: unknown };
    const cwd = typeof v.cwd === 'string' && v.cwd ? `  (in ${v.cwd})` : '';
    if (typeof v.command !== 'string') {
      return `${args}${cwd}`;
    }
    // Show what will actually run: the editor makes linters check-only and refuses some commands.
    const guard = guardCommand(v.command);
    if (guard.refused) {
      return `${v.command}${cwd}\n⛔ Will not run: ${guard.refused}`;
    }
    const note = guard.notes.length ? `\n(check mode: ${guard.notes.join('; ')})` : '';
    return `${guard.command}${cwd}${note}`;
  } catch {
    return args;
  }
}

export function trueforgeUrl(): string {
  return vscode.workspace
    .getConfiguration('forgeAgent')
    .get<string>('trueforgeUrl', 'http://127.0.0.1:8790')
    .replace(/\/+$/, '');
}

export function mcpServerName(): string {
  return vscode.workspace.getConfiguration('forgeAgent').get<string>('mcpServerName', 'forge-editor');
}
