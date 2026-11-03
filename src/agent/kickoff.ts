/**
 * Scout kickoff: for a chat request that creates something across several files, the editor ends
 * the user's message with the exact first step: delegate discovery to a "scout" sub-agent
 * (TrueForge dynamic sub-agents). A rule in the system prompt alone was followed only some of the
 * time; the latest user message is what models follow most reliably. The scout explores in its own
 * thread and reports only "path:lines - why", so the main agent's context stays small and the
 * session shows a separate sub-agent thread. Pure logic (no vscode import) so it is unit-tested.
 */

const CREATES = /\b(add|adds|adding|new|create|creates|another|implement|introduce)\b/i;
const MULTI_FILE = /\b(tests?|tested|document|documented|documentation|docs|changelog)\b/i;

/** The scout's brief: it sees nothing of the conversation, so the request is copied word for word. */
export function scoutInput(request: string): string {
  return (
    `TASK: ${request.trim()}\n\n` +
    'Your first action must be a call to retrieve_context with query = the TASK text above copied exactly (do not ' +
    'rephrase it) and budget_tokens 4500: it returns the existing similar features (the pattern), where they are ' +
    'registered, their tests and their docs. Then confirm ' +
    'the exact line ranges with file_outline or read_file with start_line/end_line (never whole files). Use at most ' +
    '8 tool calls. Find every place that must change: implementation, where similar existing features are ' +
    'registered or wired up, an existing test of a similar feature to copy, the documentation section of a ' +
    'similar feature, every other docs page that lists the similar features (e.g. an API reference), and the ' +
    'changelog. Do not change anything. Reply only with lines of the form path:start-end - what must change and why.'
  );
}

/**
 * The note appended to the user's message, or undefined when the request is not a multi-file
 * creation (a question, a one-line fix, an inline edit).
 */
export function scoutKickoff(request: string, patterns: readonly string[]): string | undefined {
  if (!CREATES.test(request) || !(patterns.length > 0 || MULTI_FILE.test(request))) {
    return undefined;
  }
  return (
    'Editor note: this request changes several files. Your first action, with no text before it, must be this ' +
    'call to delegate discovery:\n' +
    `create_sub_agent with name "scout" and input:\n"""\n${scoutInput(request)}\n"""\n` +
    'After the scout reports, read only the line ranges it lists that are not already in the context above, ' +
    'write your checklist, then propose the changes.'
  );
}
