/**
 * Model fallback (Task C): what to do when a TrueForge turn ends with a model error.
 * TrueForge has no fallback of its own, so the editor drives it: retry a transient failure once on
 * the same model, otherwise switch the session to the next configured model (PATCH of the inline
 * spec) and send the request again. Nothing is written before review, so a failed model never
 * changes the workspace. Pure logic (no vscode import) so it is unit-tested.
 */

/** Delay before the one retry of a transient failure on the same model. */
export const RETRY_DELAY_MS = 3000;

export type FailureAction =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'switch'; model: string }
  | { kind: 'give-up'; reason: string };

/** Failures of the model call itself (not of the agent: iteration limits, cancelled turns, ...). */
export function isModelFailure(message: string): boolean {
  if (/iteration limit|max(?:imum)? (?:iterations|steps)/i.test(message)) {
    return false;
  }
  return (
    /\[Model Error\]/i.test(message) ||
    /\b(?:401|403|404|408|429|500|502|503|504)\b|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed? ?out|rate.?limit|unauthori[sz]ed|forbidden|invalid.{0,20}(?:key|token)|cannot connect|overloaded|unavailable/i.test(
      message,
    )
  );
}

/** Worth one more try on the same model (busy or flaky), as opposed to broken configuration. */
export function isTransient(message: string): boolean {
  if (/\b(?:401|403|404)\b|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|unauthori[sz]ed|forbidden|invalid.{0,20}(?:key|token)|not found|bad port/i.test(message)) {
    return false;
  }
  return /\b(?:408|429|500|502|503|504)\b|ECONNRESET|ETIMEDOUT|timed? ?out|rate.?limit|overloaded|temporarily|unavailable|socket hang up/i.test(
    message,
  );
}

/** Primary first, then the fallbacks, without duplicates or blanks. */
export function modelChain(primary: string, fallbacks: readonly string[]): string[] {
  return [...new Set([primary, ...fallbacks].map(m => m.trim()).filter(Boolean))];
}

/**
 * Next step after a model failure.
 * @param tried models that already failed in this request (the current one included)
 * @param retried whether the current model already had its transient-failure retry
 */
export function nextAction(message: string, current: string, chain: readonly string[], tried: ReadonlySet<string>, retried: boolean): FailureAction {
  if (!isModelFailure(message)) {
    return { kind: 'give-up', reason: 'not a model failure' };
  }
  if (isTransient(message) && !retried) {
    return { kind: 'retry', delayMs: RETRY_DELAY_MS };
  }
  const next = chain.find(m => m !== current && !tried.has(m));
  if (next) {
    return { kind: 'switch', model: next };
  }
  return { kind: 'give-up', reason: chain.length > 1 ? 'every configured model failed' : 'no fallback model is configured' };
}

/** A short, readable reason from a TrueForge model error ("401 Unauthorized", "Cannot connect to API: ..."). */
export function shortReason(message: string): string {
  return message
    .replace(/^The model call failed:\s*/i, '')
    .replace(/\[Model Error\]\s*/i, '')
    .trim()
    .slice(0, 160);
}
