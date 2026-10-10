// Supabase auth errors come back as backend wording ("Invalid login
// credentials", "Legacy API keys are disabled") — fine for logs, not for an
// actor at a login form. This maps the ones people actually hit to plain
// language and falls back to a generic message instead of leaking the rest.

type AuthErrorLike = { message?: string; status?: number; code?: string } | null | undefined;

export function friendlyAuthError(error: AuthErrorLike, action: "log in" | "sign up" | "reset" | "update"): string {
  const message = (error?.message ?? "").toLowerCase();
  const code = error?.code ?? "";

  if (code === "invalid_credentials" || message.includes("invalid login credentials")) {
    return "That email and password don’t match. Check them and try again.";
  }
  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return "Confirm your email first — open the link we sent you, then log in.";
  }
  if (code === "user_already_exists" || message.includes("already registered")) {
    return "An account with this email already exists. Log in instead.";
  }
  if (code === "weak_password" || message.includes("password should be")) {
    return "Choose a stronger password: at least 6 characters.";
  }
  if (code === "same_password" || message.includes("different from the old password")) {
    return "Pick a password you haven’t used here before.";
  }
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || message.includes("rate limit") || error?.status === 429) {
    return "Too many attempts in a short time. Wait a minute and try again.";
  }
  if (message.includes("invalid email") || code === "email_address_invalid") {
    return "That doesn’t look like a valid email address.";
  }
  if (message.includes("failed to fetch") || message.includes("network")) {
    return "We couldn’t reach the server. Check your connection and try again.";
  }
  if (code === "otp_expired" || message.includes("expired")) {
    return "That link has expired. Request a new one below.";
  }

  const verb = action === "reset" ? "send the reset email" : action === "update" ? "update your password" : action;
  return `We couldn’t ${verb} just now. Please try again in a moment.`;
}
