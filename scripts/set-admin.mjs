#!/usr/bin/env node
// Grants or revokes admin portal access (/admin, api/admin.ts) by adding or
// removing the user's row in public.admins — see
// supabase/migrations/20261010120000_admins.sql.
//
// Usage:
//   node scripts/set-admin.mjs <email>            grant admin access
//   node scripts/set-admin.mjs <email> --remove   revoke admin access
//   node scripts/set-admin.mjs --list             list current admins
//
// Requires SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_URL in the environment
// or .env.local.

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

async function loadEnvLocal() {
  try {
    const text = await readFile(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // no .env.local, fall back to whatever is already in process.env
  }
}

async function findUserByEmail(supabase, email) {
  const target = email.toLowerCase();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match;
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--"));
  const remove = args.includes("--remove");
  const list = args.includes("--list");

  if (!email && !list) {
    console.error("Usage: node scripts/set-admin.mjs <email> [--remove] | --list");
    process.exit(1);
  }

  await loadEnvLocal();

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (list) {
    const { data, error } = await supabase.from("admins").select("user_id, created_at");
    if (error) throw new Error(`reading admins failed: ${error.message}`);
    if (data.length === 0) {
      console.log("No admins.");
      return;
    }
    for (const row of data) {
      const { data: found } = await supabase.auth.admin.getUserById(row.user_id);
      console.log(`${found?.user?.email ?? "(unknown email)"}  ${row.user_id}  since ${row.created_at}`);
    }
    return;
  }

  const user = await findUserByEmail(supabase, email);
  if (!user) {
    console.error(`No user found for ${email}.`);
    process.exit(1);
  }

  if (remove) {
    const { error } = await supabase.from("admins").delete().eq("user_id", user.id);
    if (error) throw new Error(`revoking admin failed: ${error.message}`);
    console.log(`${user.email} (${user.id}) is no longer an admin.`);
    return;
  }

  const { error } = await supabase
    .from("admins")
    .upsert({ user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true });
  if (error) throw new Error(`granting admin failed: ${error.message}`);
  console.log(`${user.email} (${user.id}) is now an admin.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
