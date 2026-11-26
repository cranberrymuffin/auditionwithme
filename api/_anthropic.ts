import Anthropic from "@anthropic-ai/sdk";
import type { VercelResponse } from "@vercel/node";

export const anthropic = new Anthropic();

/**
 * A signal that aborts a route's model work shortly before Vercel would kill
 * the function (maxDuration in vercel.json), so the caller gets our own 504
 * with a message instead of the platform's opaque one. A signal rather than
 * the SDK's `timeout` option: that only covers the wait for the response to
 * start, not a stream that is still running, and each retry restarts it.
 */
export function modelDeadline(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Answers a failed model call. The provider's own message stays in the logs
 * — it can name models, limits and request ids — and the client gets
 * `fallback`, or a timeout/busy message it can act on.
 */
export function sendModelError(
  res: VercelResponse,
  label: string,
  err: unknown,
  fallback: string,
  signal?: AbortSignal,
) {
  if (
    signal?.aborted ||
    err instanceof Anthropic.APIUserAbortError ||
    err instanceof Anthropic.APIConnectionTimeoutError
  ) {
    console.error(`${label}: model call ran past its deadline`);
    return res
      .status(504)
      .json({ error: "That took too long to process. Please try again.", reason: "timeout" });
  }
  console.error(`${label}:`, err);
  // 529 is Anthropic's "overloaded".
  if (
    err instanceof Anthropic.RateLimitError ||
    (err instanceof Anthropic.APIError && err.status === 529)
  ) {
    return res
      .status(503)
      .json({ error: "The service is busy right now. Please try again in a moment." });
  }
  return res.status(500).json({ error: fallback });
}
