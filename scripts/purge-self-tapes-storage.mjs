#!/usr/bin/env node
// Empties and deletes the "self-tapes" storage bucket (the old recorded
// videos). Supabase rejects direct SQL `delete from storage.objects` /
// `storage.buckets` on hosted projects ("Direct deletion from storage tables
// is not allowed. Use the Storage API instead.") — this script is that API
// path, run once before applying the migration that drops public.self_tapes.
//
// Usage:
//   node scripts/purge-self-tapes-storage.mjs              dry run, prints what would be deleted
//   node scripts/purge-self-tapes-storage.mjs --confirm     actually deletes objects + the bucket
//
// Requires SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_URL in the environment or .env.local.

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

// Bucket contents are one folder per user ("<user_id>/<self_tape_id>.webm")
// — list the top-level folders, then list+collect files inside each.
async function listAllPaths(supabase, bucket) {
  const paths = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const { data: folders, error } = await supabase.storage
      .from(bucket)
      .list("", { limit, offset });
    if (error) throw new Error(`listing bucket root failed: ${error.message}`);
    if (!folders || folders.length === 0) break;

    for (const folder of folders) {
      const { data: files, error: filesError } = await supabase.storage
        .from(bucket)
        .list(folder.name, { limit: 1000 });
      if (filesError) throw new Error(`listing ${folder.name} failed: ${filesError.message}`);
      for (const file of files ?? []) {
        paths.push(`${folder.name}/${file.name}`);
      }
    }

    if (folders.length < limit) break;
    offset += limit;
  }
  return paths;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const bucket = "self-tapes";

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

  const paths = await listAllPaths(supabase, bucket);
  console.log(`Found ${paths.length} object(s) in the "${bucket}" bucket.`);

  if (!confirm) {
    console.log("\nDry run only — nothing was deleted. Re-run with --confirm to actually delete.");
    return;
  }

  // remove() takes an array of paths; batch to keep requests reasonably sized.
  const BATCH = 100;
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    if (batch.length === 0) continue;
    const { error } = await supabase.storage.from(bucket).remove(batch);
    if (error) throw new Error(`deleting objects failed: ${error.message}`);
    console.log(`Deleted ${Math.min(i + BATCH, paths.length)}/${paths.length} object(s)...`);
  }

  const { error: deleteBucketError } = await supabase.storage.deleteBucket(bucket);
  if (deleteBucketError) {
    throw new Error(`deleting bucket failed: ${deleteBucketError.message}`);
  }

  console.log(`Deleted all objects and the "${bucket}" bucket itself.`);
  console.log("Now apply the migration that drops public.scripts/public.self_tapes.");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
