/**
 * Owns every write the agent makes. A write happens only when TrueForge executes an approved
 * propose_write call AND this controller holds the user's per-hunk decision for exactly that
 * proposal. Each applied change is one atomic WorkspaceEdit (so Cmd+Z undoes it) and is recorded
 * so "Revert last agent change" can restore the previous text even after saving.
 */
import * as vscode from 'vscode';
import { applyHunks, computeHunks, type Hunk } from './diff';
import { buildProposal, normalizeProposeArgs, proposalKey, type Proposal } from './proposal';

export interface AppliedChange {
  id: string;
  rel: string;
  uri: vscode.Uri;
  /** text before the change (original line endings); null = the file did not exist */
  before: string | null;
  after: string;
  acceptedHunks: number;
  totalHunks: number;
  added: number;
  removed: number;
}

interface ApprovedProposal {
  hunks: Hunk[];
  accepted: boolean[];
}

export type ChangeEvent =
  | { type: 'applied'; change: AppliedChange }
  | { type: 'reverted'; change: AppliedChange };

export class ChangeController {
  private readonly approved = new Map<string, ApprovedProposal>();
  private readonly history: AppliedChange[] = [];
  private seq = 0;

  constructor(
    private readonly onEvent: (e: ChangeEvent) => void,
    private readonly log: (msg: string) => void,
  ) {}

  /** Remember the user's decision for this proposal (called before TrueForge is told "allow"). */
  recordApproval(proposal: Proposal, hunks: Hunk[], accepted: boolean[]): void {
    this.approved.set(proposalKey(proposal), { hunks, accepted });
  }

  forgetApprovals(): void {
    this.approved.clear();
  }

  /** Executed by the propose_write MCP tool after TrueForge approval. Returns the tool result text. */
  async applyApproved(rawArgs: unknown): Promise<string> {
    const proposal = await buildProposal(normalizeProposeArgs(rawArgs));
    const key = proposalKey(proposal);
    const decision = this.approved.get(key);
    if (!decision) {
      throw new Error(
        `This change to ${proposal.rel} was not reviewed in the editor, so it was not applied. ` +
          'Every write must go through the user\'s review.',
      );
    }
    this.approved.delete(key);

    // The file must not have changed since the review: recompute and compare the hunks.
    const hunks = computeHunks(proposal.original, proposal.proposed);
    const same =
      hunks.length === decision.hunks.length && hunks.every((h, i) => h.header === decision.hunks[i].header);
    if (!same) {
      throw new Error(`${proposal.rel} changed while the review was open; nothing was applied. Propose the change again.`);
    }

    const finalText = applyHunks(proposal.original, hunks, decision.accepted).split('\n').join(proposal.eol);
    const uri = vscode.Uri.file(proposal.abs);
    const edit = new vscode.WorkspaceEdit();
    if (proposal.exists) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(uri, full, finalText);
    } else {
      edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
      edit.insert(uri, new vscode.Position(0, 0), finalText);
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      throw new Error(`VS Code refused the edit to ${proposal.rel}; nothing was applied.`);
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();

    const acceptedHunks = hunks.filter((_, i) => decision.accepted[i]);
    const change: AppliedChange = {
      id: `chg-${++this.seq}`,
      rel: proposal.rel,
      uri,
      before: proposal.exists ? proposal.rawOriginal : null,
      after: finalText,
      acceptedHunks: acceptedHunks.length,
      totalHunks: hunks.length,
      added: acceptedHunks.reduce((n, h) => n + h.added, 0),
      removed: acceptedHunks.reduce((n, h) => n + h.removed, 0),
    };
    this.history.push(change);
    this.log(`applied ${change.id}: ${change.rel} (${change.acceptedHunks}/${change.totalHunks} hunks)`);
    this.onEvent({ type: 'applied', change });

    const rejected = hunks.filter((_, i) => !decision.accepted[i]);
    let result =
      `Applied ${change.acceptedHunks} of ${change.totalHunks} hunk(s) to ${change.rel} ` +
      `(+${change.added} −${change.removed})${proposal.exists ? '' : ' — new file created'}.`;
    if (rejected.length > 0) {
      result +=
        `\nThe user REJECTED ${rejected.length} hunk(s); those parts of the file are unchanged:\n` +
        rejected.map(h => `${h.header}\n${h.lines.join('\n')}`).join('\n') +
        '\nDo not propose the rejected changes again unless the user asks for them.';
    }
    return result;
  }

  latest(): AppliedChange | undefined {
    return this.history[this.history.length - 1];
  }

  /** Revert the most recent applied change (only the latest, so reverts never conflict). */
  async revert(changeId?: string): Promise<string> {
    const change = this.latest();
    if (!change) {
      return 'There is no agent change to revert.';
    }
    if (changeId && change.id !== changeId) {
      return 'Only the most recent agent change can be reverted; revert the newer ones first.';
    }
    const edit = new vscode.WorkspaceEdit();
    let current: string | undefined;
    try {
      current = (await vscode.workspace.openTextDocument(change.uri)).getText();
    } catch {
      current = undefined;
    }
    if (current !== undefined && current !== change.after) {
      const choice = await vscode.window.showWarningMessage(
        `${change.rel} was edited after the agent's change. Revert to the version before the agent's change anyway?`,
        { modal: true },
        'Revert',
      );
      if (choice !== 'Revert') {
        return 'Revert cancelled.';
      }
    }
    if (change.before === null) {
      edit.deleteFile(change.uri, { ignoreIfNotExists: true });
    } else {
      const doc = await vscode.workspace.openTextDocument(change.uri);
      edit.replace(change.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), change.before);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      return `VS Code refused to revert ${change.rel}.`;
    }
    if (change.before !== null) {
      await (await vscode.workspace.openTextDocument(change.uri)).save();
    }
    this.history.pop();
    this.log(`reverted ${change.id}: ${change.rel}`);
    this.onEvent({ type: 'reverted', change });
    return `Reverted the agent's change to ${change.rel}.`;
  }
}
