// Supabase auth errors come back as backend wording ("Invalid login
// credentials", "Legacy API keys are disabled") — fine for logs, not for an
// actor at a login form. This maps every code the email/password flows we use
// (sign up, resend, sign in, reset email, update password, change email or
// password from account settings) can return to plain
// language and falls back to a generic message instead of leaking the rest.
// MFA, SSO/SAML, OAuth, phone and admin codes aren't listed: we never call
// those APIs. Codes are from @supabase/auth-js lib/error-codes.

type AuthErrorLike =
  | { message?: string; status?: number; code?: string; name?: string; reasons?: string[] }
  | null
  | undefined;

type AuthAction = "log in" | "sign up" | "reset" | "update" | "change email" | "change password";

export function friendlyAuthError(error: AuthErrorLike, action: AuthAction): string {
  const message = (error?.message ?? "").toLowerCase();
  const code = error?.code ?? "";

  // Credentials and account state
  if (code === "invalid_credentials" || message.includes("invalid login credentials")) {
    return "That email and password don’t match. Check them and try again.";
  }
  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return "Confirm your email first — open the link we sent you, then log in.";
  }
  if (code === "user_already_exists" || code === "email_exists" || message.includes("already registered")) {
    return action === "change email"
      ? "Another account already uses that email."
      : "An account with this email already exists. Log in instead.";
  }
  if (code === "user_banned") {
    return "This account has been suspended. Contact support if you think that’s a mistake.";
  }
  if (code === "user_not_found") {
    return action === "update"
      ? "We couldn’t find your account. Request a new reset link and try again."
      : "We couldn’t find an account with that email.";
  }

  // Passwords. same_password is checked before weak_password: "New password
  // should be different from the old password" also contains "password should be".
  if (code === "same_password" || message.includes("different from the old password")) {
    return "That’s already your password. Choose a new one, or just log in with it.";
  }
  if (code === "weak_password" || message.includes("password should be")) {
    // Supabase rejects for length, missing character classes, or a password
    // found in a known breach — say which one instead of always blaming length.
    const reasons = error?.reasons ?? [];
    if (reasons.includes("pwned")) {
      return "That password has shown up in a data breach. Choose a different one.";
    }
    if (reasons.includes("characters")) {
      return "Choose a stronger password: mix upper- and lowercase letters, numbers, and symbols.";
    }
    return "Choose a stronger password: at least 6 characters.";
  }
  if (code === "reauthentication_needed" || code === "reauthentication_not_valid") {
    return "For security, log in again before changing your password.";
  }

  // Email address
  if (code === "email_address_invalid" || message.includes("invalid email")) {
    return "That doesn’t look like a valid email address.";
  }
  if (code === "email_address_not_authorized") {
    return "We can’t send email to that address right now. Try a different email or contact support.";
  }

  // Signups and providers switched off in the Supabase dashboard
  if (code === "signup_disabled" || message.includes("signups not allowed")) {
    return "New sign-ups are closed right now. Check back soon.";
  }
  if (code === "email_provider_disabled" || code === "provider_disabled") {
    return "Email sign-in is turned off right now. Please try again later.";
  }

  // Bot protection
  if (code === "captcha_failed") {
    return "We couldn’t verify you’re human. Refresh the page and try again.";
  }

  // Rate limits
  if (
    code === "over_email_send_rate_limit" ||
    code === "over_request_rate_limit" ||
    message.includes("rate limit") ||
    error?.status === 429
  ) {
    return "Too many attempts in a short time. Wait a minute and try again.";
  }

  // Expired or missing links and sessions. A reset link's recovery session can
  // lapse before the new password is submitted; auth-js reports that as
  // AuthSessionMissingError ("Auth session missing!"), which has no code.
  if (
    code === "otp_expired" ||
    code === "session_expired" ||
    code === "session_not_found" ||
    code === "refresh_token_not_found" ||
    code === "refresh_token_already_used" ||
    code === "bad_jwt" ||
    code === "flow_state_expired" ||
    code === "flow_state_not_found" ||
    code === "bad_code_verifier" ||
    code === "otp_disabled" ||
    error?.name === "AuthSessionMissingError" ||
    message.includes("session missing") ||
    message.includes("expired")
  ) {
    if (action === "change email" || action === "change password") {
      return "Your session has expired. Log in again, then try once more.";
    }
    return action === "update"
      ? "Your reset link has expired. Request a new one to set your password."
      : "That link has expired. Request a new one below.";
  }

  // Connectivity and server-side timeouts
  if (message.includes("failed to fetch") || message.includes("network")) {
    return "We couldn’t reach the server. Check your connection and try again.";
  }
  if (code === "request_timeout" || code.startsWith("hook_timeout")) {
    return "The server took too long to respond. Please try again.";
  }

  // validation_failed, bad_json, unexpected_failure, hook_payload_*, conflict
  // and anything newer than this SDK fall through to the generic message.
  const verb =
    action === "reset"
      ? "send the reset email"
      : action === "update" || action === "change password"
        ? "update your password"
        : action === "change email"
          ? "change your email"
          : action;
  return `We couldn’t ${verb} just now. Please try again in a moment.`;
}
