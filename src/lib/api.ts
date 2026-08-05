import { supabase } from "./supabase";

/**
 * fetch() with the current Supabase access token attached. Every call to an
 * /api/* route must go through this — those routes verify the JWT server-side.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
