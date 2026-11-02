/**
 * Hunk-by-hunk review in the editor. Each proposal opens as a read-only diff document
 * (forge-review:) with ✓ Accept / ✗ Reject CodeLens above every hunk, plus Accept all /
 * Reject all / side-by-side at the top. The review resolves once every hunk has a decision;
 * nothing is written to disk here.
 */
import * as vscode from 'vscode';
import type { Hunk } from './diff';
import type { Proposal } from './proposal';

export const REVIEW_SCHEME = 'forge-review';
export const PROPOSED_SCHEME = 'forge-proposed';

export type HunkState = 'pending' | 'accepted' | 'rejected';

interface Review {
  callId: string;
  proposal: Proposal;
  hunks: Hunk[];
  states: HunkState[];
  uri: vscode.Uri;
  /** line of each hunk's @@ header in the rendered document */
  headerLines: number[];
  column: vscode.ViewColumn;
  title: string;
  resolve: (accepted: boolean[] | null) => void;
  onChange?: (states: HunkState[]) => void;
}

export interface ReviewOptions {
  /** where the review opens (inline edits open beside the file being edited) */
  column?: vscode.ViewColumn;
  /** first header line, e.g. "Inline edit: make it faster" */
  title?: string;
  onChange?: (states: HunkState[]) => void;
}

export class ReviewManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private readonly reviews = new Map<string, Review>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  readonly onDidChangeCodeLenses = this.lensesChanged.event;

  register(context: vscode.ExtensionContext): void {
    const proposedProvider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: uri => {
        const [callId, which] = uri.path.split('/').filter(Boolean);
        const r = this.reviews.get(decodeURIComponent(callId ?? ''));
        if (!r) {
          return '';
        }
        return (which === 'before' ? r.proposal.original : r.proposal.proposed).split('\n').join(r.proposal.eol);
      },
    };
    context.subscriptions.push(
      this.changed,
      this.lensesChanged,
      vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, this),
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposedProvider),
      vscode.languages.registerCodeLensProvider({ scheme: REVIEW_SCHEME }, this),
      vscode.commands.registerCommand('forgeAgent.review.hunk', (callId: string, index: number, accept: boolean) =>
        this.decideHunk(callId, index, accept),
      ),
      vscode.commands.registerCommand('forgeAgent.review.all', (callId: string, accept: boolean) =>
        this.decideAll(callId, accept),
      ),
      vscode.commands.registerCommand('forgeAgent.review.sideBySide', (callId: string) => this.openSideBySide(callId)),
    );
  }

  /** Open a review and wait for the decision. Resolves with per-hunk acceptance, or null if cancelled. */
  start(callId: string, proposal: Proposal, hunks: Hunk[], options: ReviewOptions = {}): Promise<boolean[] | null> {
    return new Promise(resolve => {
      const uri = vscode.Uri.from({
        scheme: REVIEW_SCHEME,
        path: `/${encodeURIComponent(callId)}/${proposal.rel}.diff`,
      });
      this.reviews.set(callId, {
        callId,
        proposal,
        hunks,
        states: hunks.map(() => 'pending'),
        uri,
        headerLines: [],
        column: options.column ?? vscode.ViewColumn.One,
        title:
          options.title ??
          `Forge Agent proposes ${proposal.exists ? 'a change to' : 'a NEW file'} ${proposal.rel}`,
        resolve,
        onChange: options.onChange,
      });
      this.open(callId).catch((err: unknown) => {
        void vscode.window.showErrorMessage(
          `Forge Agent could not open the review for ${proposal.rel}: ${err instanceof Error ? err.message : String(err)}. ` +
            'Use "Open review" in the agent panel to retry.',
        );
      });
    });
  }

  isOpen(callId: string): boolean {
    return this.reviews.has(callId);
  }

  async open(callId: string): Promise<void> {
    const r = this.reviews.get(callId);
    if (!r) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(r.uri);
    if (doc.languageId !== 'diff') {
      await vscode.languages.setTextDocumentLanguage(doc, 'diff');
    }
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: r.column });
  }

  /** Cancel every open review (e.g. the user pressed Stop): nothing gets applied. */
  cancelAll(): void {
    for (const r of [...this.reviews.values()]) {
      this.finish(r, null);
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const callId = decodeURIComponent(uri.path.split('/').filter(Boolean)[0] ?? '');
    const r = this.reviews.get(callId);
    if (!r) {
      return '# This review is closed.\n';
    }
    const added = r.hunks.reduce((n, h) => n + h.added, 0);
    const removed = r.hunks.reduce((n, h) => n + h.removed, 0);
    const out: string[] = [
      `# ${r.title.replace(/\s+/g, ' ').slice(0, 200)}`,
      `# ${r.hunks.length} hunk(s) · +${added} −${removed} · nothing is written until you decide every hunk`,
    ];
    if (r.proposal.description) {
      out.push(`# ${r.proposal.description.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    out.push('');
    r.headerLines = [];
    r.hunks.forEach((h, i) => {
      const mark = r.states[i] === 'accepted' ? '✓ accepted' : r.states[i] === 'rejected' ? '✗ rejected' : '… pending';
      r.headerLines.push(out.length);
      out.push(`${h.header}   hunk ${i + 1}/${r.hunks.length}   ${mark}`);
      out.push(...h.lines);
      out.push('');
    });
    return out.join('\n');
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const callId = decodeURIComponent(document.uri.path.split('/').filter(Boolean)[0] ?? '');
    const r = this.reviews.get(callId);
    if (!r) {
      return [];
    }
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, { title: '✓ Accept all', command: 'forgeAgent.review.all', arguments: [callId, true] }),
      new vscode.CodeLens(top, { title: '✗ Reject all', command: 'forgeAgent.review.all', arguments: [callId, false] }),
      new vscode.CodeLens(top, { title: '⇆ Side-by-side', command: 'forgeAgent.review.sideBySide', arguments: [callId] }),
    ];
    r.headerLines.forEach((line, i) => {
      if (line >= document.lineCount) {
        return;
      }
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: r.states[i] === 'accepted' ? '✓ Accepted' : '✓ Accept',
          command: 'forgeAgent.review.hunk',
          arguments: [callId, i, true],
        }),
        new vscode.CodeLens(range, {
          title: r.states[i] === 'rejected' ? '✗ Rejected' : '✗ Reject',
          command: 'forgeAgent.review.hunk',
          arguments: [callId, i, false],
        }),
      );
    });
    return lenses;
  }

  private decideHunk(callId: string, index: number, accept: boolean): void {
    const r = this.reviews.get(callId);
    if (!r || index < 0 || index >= r.states.length) {
      return;
    }
    r.states[index] = accept ? 'accepted' : 'rejected';
    this.refresh(r);
  }

  private decideAll(callId: string, accept: boolean): void {
    const r = this.reviews.get(callId);
    if (!r) {
      return;
    }
    r.states = r.states.map(() => (accept ? 'accepted' : 'rejected'));
    this.refresh(r);
  }

  private refresh(r: Review): void {
    r.onChange?.(r.states);
    if (r.states.every(s => s !== 'pending')) {
      this.finish(
        r,
        r.states.map(s => s === 'accepted'),
      );
      return;
    }
    this.changed.fire(r.uri);
    this.lensesChanged.fire();
  }

  private finish(r: Review, accepted: boolean[] | null): void {
    this.reviews.delete(r.callId);
    r.resolve(accepted);
    this.changed.fire(r.uri);
    this.lensesChanged.fire();
    void closeTabsFor(r.uri, r.callId);
  }

  private async openSideBySide(callId: string): Promise<void> {
    const r = this.reviews.get(callId);
    if (!r) {
      return;
    }
    const enc = encodeURIComponent(callId);
    const left = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${enc}/before/${r.proposal.rel}` });
    const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${enc}/after/${r.proposal.rel}` });
    await vscode.commands.executeCommand('vscode.diff', left, right, `${r.proposal.rel}: current ↔ proposed (Forge Agent)`, {
      preview: true,
    });
  }
}

async function closeTabsFor(reviewUri: vscode.Uri, callId: string): Promise<void> {
  const enc = encodeURIComponent(callId);
  const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(tab => {
    const input = tab.input;
    if (input instanceof vscode.TabInputText) {
      return input.uri.toString() === reviewUri.toString();
    }
    if (input instanceof vscode.TabInputTextDiff) {
      return input.modified.scheme === PROPOSED_SCHEME && input.modified.path.startsWith(`/${enc}/`);
    }
    return false;
  });
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs);
  }
}
