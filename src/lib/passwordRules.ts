// One rule for every place a password is chosen (sign up, reset, account
// settings). Supabase enforces its own minimum server-side (Auth settings);
// keep the two in step.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters.`;
