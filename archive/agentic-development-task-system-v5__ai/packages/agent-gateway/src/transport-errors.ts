/**
 * Classifies whether an error thrown by a provider adapter is a transient TRANSPORT drop (the stream
 * dropped mid-response) rather than a logic/engineering failure. A transport drop is
 * resumable: the retry should continue the prior session (via its persisted resume token) instead of
 * treating the failure as a reason to cold-restart or block. The Claude Agent SDK's `readMessages`
 * surfaces `API Error: Connection closed mid-response`; without this classification each Temporal
 * retry cold-starts and re-does work. Matching this string is what lets the retry resume.
 */
const RESUMABLE_TRANSPORT_PATTERNS: RegExp[] = [
  /connection closed mid-response/i,
  /connection closed/i,
  /connection reset/i,
  /ECONNRESET/i,
  /socket hang up/i,
  /premature close/i,
  /stream (?:closed|ended) unexpectedly/i,
];

export function isResumableTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message) return false;
  return RESUMABLE_TRANSPORT_PATTERNS.some((pattern) => pattern.test(message));
}
