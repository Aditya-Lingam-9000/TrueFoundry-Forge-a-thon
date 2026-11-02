/**
 * Inline edit (Cmd/Ctrl+I): select code, type an instruction, review the proposed diff beside the
 * file, accept or reject each hunk.
 *
 * Each inline edit is one fresh, lean TrueForge session (agent/inline-edit.json): the prompt holds
 * the selection and a little context, the agent answers with a single propose_write, TrueForge
 * pauses for approval, and the same hunk-by-hunk review as agent mode decides what is written.
 * Changes outside the selected lines are refused before the user ever sees them.
 */
import * as vscode from 'vscode';
import type { AgentSession, PanelMessage } from '../agent/agentSession';
import type { SelectionScope } from '../review/proposal';

const CONTEXT_LINES = 15;

export interface InlineEditDeps {
  session: AgentSession;
  log: (msg: string) => void;
  /** receives panel messages of the running inline edit (to show progress), or none */
  setProgressSink: (sink: ((msg: PanelMessage) => void) | undefined) => void;
}

export function registerInlineEdit(context: vscode.ExtensionContext, deps: InlineEditDeps): void {
  context.subscriptions.push(vscode.commands.registerCommand('forgeAgent.inlineEdit', () => runInlineEdit(deps)));
}

async function runInlineEdit(deps: InlineEditDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('Forge Agent: open a file and select the code to edit.');
    return;
  }
  const doc = editor.document;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (doc.uri.scheme !== 'file' || !folder) {
    void vscode.window.showInformationMessage('Forge Agent: inline edit works on files inside the open workspace.');
    return;
  }
  if (deps.session.isBusy) {
    void vscode.window.showInformationMessage('Forge Agent is already working on an inline edit.');
    return;
  }

  // Whole lines of the selection (a selection ending at column 0 does not include that line).
  const sel = editor.selection;
  const startLine = sel.start.line;
  let endLine = sel.end.line;
  if (endLine > startLine && sel.end.character === 0) {
    endLine--;
  }
  const lines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    lines.push(doc.lineAt(i).text);
  }
  const selected = lines.join('\n');
  if (!selected.trim()) {
    void vscode.window.showInformationMessage('Forge Agent: select the code you want to change first.');
    return;
  }
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const range = `${startLine + 1}-${endLine + 1}`;

  const instruction = await vscode.window.showInputBox({
    title: `Forge Agent · inline edit of ${rel}:${range}`,
    prompt: 'What should change in the selected code?',
    placeHolder: 'e.g. also treat "off" and "n" as false and update the docstring',
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) {
    return;
  }

  const before: string[] = [];
  for (let i = Math.max(0, startLine - CONTEXT_LINES); i < startLine; i++) {
    before.push(doc.lineAt(i).text);
  }
  const after: string[] = [];
  for (let i = endLine + 1; i <= Math.min(doc.lineCount - 1, endLine + CONTEXT_LINES); i++) {
    after.push(doc.lineAt(i).text);
  }
  const fence = '```';
  const lang = doc.languageId;
  const prompt = [
    `Inline edit of ${rel}, lines ${range}.`,
    `Instruction: ${instruction.trim()}`,
    '',
    'Selected code (use it EXACTLY as old_text):',
    `${fence}${lang}`,
    selected,
    fence,
    '',
    `Context before the selection (lines ${Math.max(1, startLine - CONTEXT_LINES + 1)}-${startLine}; do not change):`,
    `${fence}${lang}`,
    before.join('\n'),
    fence,
    '',
    `Context after the selection (do not change):`,
    `${fence}${lang}`,
    after.join('\n'),
    fence,
    '',
    `Call propose_write once with path="${rel}", old_text = the selected code, new_text = the edited code.`,
  ].join('\n');

  const scope: SelectionScope = { rel, startLine: startLine + 1, endLine: endLine + 1, text: selected };
  deps.log(`inline edit ${rel}:${range}: ${instruction}`);

  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Forge Agent · ${instruction.trim().slice(0, 60)}`,
      cancellable: true,
    },
    async (progress, token) => {
      let streamed = '';
      progress.report({ message: 'asking the model through TrueForge…' });
      deps.setProgressSink(msg => {
        if (msg.type === 'assistantDelta') {
          streamed = (streamed + msg.text).slice(-200);
          const tail = streamed.replace(/\s+/g, ' ').trim().slice(-70);
          if (tail) {
            progress.report({ message: tail });
          }
        } else if (msg.type === 'toolCall' && msg.name === 'propose_write') {
          progress.report({ message: 'preparing the diff…' });
        } else if (msg.type === 'review' && msg.state === 'pending') {
          progress.report({ message: 'review the change beside your code: ✓ Accept / ✗ Reject each hunk' });
        } else if (msg.type === 'review' && msg.state === 'invalid') {
          progress.report({ message: 'the model will retry…' });
        }
      });
      const stop = token.onCancellationRequested(() => void deps.session.stop());
      try {
        return await deps.session.send(prompt, {
          display: `✏️ Inline edit · ${rel}:${range}\n${instruction.trim()}`,
          scope,
          reviewTitle: `Inline edit of ${rel} lines ${range}: ${instruction.trim()}`,
        });
      } finally {
        stop.dispose();
        deps.setProgressSink(undefined);
      }
    },
  );

  if (outcome.status === 'error') {
    void vscode.window.showErrorMessage(`Forge Agent inline edit failed — nothing was changed. ${outcome.message ?? ''}`);
  } else if (outcome.status === 'stopped') {
    void vscode.window.showInformationMessage('Forge Agent: inline edit stopped — nothing unapproved was written.');
  } else if (outcome.status === 'busy') {
    void vscode.window.showInformationMessage(outcome.message ?? 'Forge Agent is busy.');
  }
}
