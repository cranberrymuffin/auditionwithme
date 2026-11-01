// Checks readAuthLink (src/lib/authLink.ts): where Supabase email links put
// the PKCE code, errors and messages once the app uses the PKCE flow.
import assert from "node:assert/strict";
import { hasAuthLink, readAuthLink } from "../../src/lib/authLink";

const base = "https://auditionwithme.com";

assert.deepEqual(readAuthLink(`${base}/login`), { code: null, error: null, message: null });
assert.equal(hasAuthLink(readAuthLink(`${base}/login`)), false);

// The PKCE code arrives in the query string.
assert.deepEqual(readAuthLink(`${base}/reset-password?code=abc-123`), {
  code: "abc-123",
  error: null,
  message: null,
});

// Errors: query (PKCE) or hash, description preferred over the bare code.
assert.equal(
  readAuthLink(`${base}/login?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`).error,
  "Email link is invalid or has expired",
);
assert.equal(readAuthLink(`${base}/login#error=access_denied`).error, "access_denied");

// A half-finished email change reports a message in the hash.
const change = readAuthLink(`${base}/account/settings#message=Confirmation+link+accepted.+Please+proceed+to+confirm+link+sent+to+the+other+email`);
assert.equal(change.message, "Confirmation link accepted. Please proceed to confirm link sent to the other email");
assert.equal(hasAuthLink(change), true);

// A code in the hash is not a PKCE code: implicit-flow tokens don't count.
assert.equal(readAuthLink(`${base}/login#access_token=x&refresh_token=y&code=z`).code, null);

console.log("auth-link: all checks passed");
