import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set");
}

// PKCE: emailed links carry a one-time code that only signs in the browser
// (or iOS app) that asked for the email, which holds the matching verifier.
// The default implicit flow put tokens in the link itself, so anyone could
// send a link that signs the reader into the sender's account.
export const supabase = createClient(url, anonKey, { auth: { flowType: "pkce" } });
