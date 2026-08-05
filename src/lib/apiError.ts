/** Error carrying the HTTP status and machine-readable `reason` field that
 * api/_entitlement.ts attaches to 401/402/403/429 responses, so callers can
 * branch on auth/grant/rate-limit failures without re-parsing the response. */
export class ApiError extends Error {
  status: number;
  reason?: string;

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** Throws an ApiError for a non-ok response, using the server's `error`
 * message/`reason` when present and falling back otherwise. No-op on ok. */
export async function throwIfError(res: Response, fallbackMessage: string): Promise<void> {
  if (res.ok) return;
  let message = fallbackMessage;
  let reason: string | undefined;
  try {
    const body = (await res.clone().json()) as { error?: string; reason?: string };
    if (body.error) message = body.error;
    reason = body.reason;
  } catch {
    // Non-JSON body — keep the fallback message.
  }
  throw new ApiError(res.status, message, reason);
}
