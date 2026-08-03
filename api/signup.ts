import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const signupSecret = process.env.SIGNUP_SECRET;

function serviceClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!signupSecret) {
    console.error("SIGNUP_SECRET is not configured");
    return res.status(500).json({
      error:
        "Account creation is temporarily disabled because SIGNUP_SECRET is not configured in production.",
    });
  }

  const { email, password, secret } = req.body as {
    email?: string;
    password?: string;
    secret?: string;
  };

  if (secret !== signupSecret) {
    return res.status(403).json({ error: "Invalid signup secret." });
  }

  if (
    !email ||
    !password ||
    typeof email !== "string" ||
    typeof password !== "string"
  ) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const origin = process.env.SITE_URL ?? req.headers.origin;
  const redirectTo = origin ? `${origin}/login` : undefined;

  try {
    const supabase = serviceClient();
    const { error } = await supabase.auth.admin.createUser({
      email,
      password,
      emailRedirectTo: redirectTo,
    });

    if (error) {
      console.error("signup failed:", error.message);
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("signup failed:", error);
    const message =
      error instanceof Error ? error.message : "Could not create account.";
    return res.status(500).json({ error: message });
  }
}
