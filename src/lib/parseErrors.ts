import { apiFetch } from "./api";
import { ApiError } from "./apiError";

// What the parse and start-rehearsal routes answer with when they can't go
// ahead, turned into something the actor can act on. `reason` lets callers
// branch: "too_large" won't clear on a retry, "timeout" and "rate_limited"
// might.
export const TOO_LARGE_MESSAGE =
  "This PDF is too large to read in one go. Upload only the pages with your scene, or a smaller, lower-resolution scan.";
export const TIMEOUT_MESSAGE =
  "That took too long to read. Try again, or upload fewer pages: just the ones with your scene.";

function waitPhrase(seconds: number | null): string {
  if (!seconds || seconds <= 90) return "in a minute";
  if (seconds < 3600) return `in about ${Math.ceil(seconds / 60)} minutes`;
  if (seconds < 20 * 3600) return `in about ${Math.ceil(seconds / 3600)} hours`;
  return "tomorrow";
}

/** The ApiError for a failed parse or start-rehearsal response. Reads the
 * body as text first: the platform's own 413 and 504 pages aren't JSON. */
export async function apiFailure(res: Response, fallback: string): Promise<ApiError> {
  let body: { error?: string; reason?: string; retryAfterSeconds?: number } = {};
  try {
    body = JSON.parse(await res.text()) as typeof body;
  } catch {
    // Not JSON (or empty): the status alone decides the message.
  }
  if (res.status === 413) return new ApiError(413, TOO_LARGE_MESSAGE, "too_large");
  if (res.status === 504 || body.reason === "timeout") {
    return new ApiError(res.status, TIMEOUT_MESSAGE, "timeout");
  }
  if (res.status === 429) {
    const header = Number(res.headers.get("Retry-After"));
    const seconds =
      typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0
        ? body.retryAfterSeconds
        : Number.isFinite(header) && header > 0
          ? header
          : null;
    return new ApiError(
      429,
      `You’re going a little fast for us. Give it a moment and try again ${waitPhrase(seconds)}.`,
      "rate_limited",
    );
  }
  return new ApiError(res.status, body.error ?? fallback, body.reason);
}

/** A grant for one upload's parse calls (api/start-rehearsal.ts): the
 * grant, or null where a plan is needed first (402). Throws an ApiError
 * with a message fit to show for anything else. */
export async function requestRehearsalGrant(): Promise<string | null> {
  const res = await apiFetch("/api/start-rehearsal", { method: "POST" });
  if (res.status === 402) return null;
  if (!res.ok) throw await apiFailure(res, "Couldn’t start a new rehearsal. Please try again.");
  const data = (await res.json().catch(() => ({}))) as { grant?: string };
  if (!data.grant) throw new ApiError(res.status, "Couldn’t start a new rehearsal. Please try again.");
  return data.grant;
}
