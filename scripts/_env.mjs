// Shared by the maintenance scripts in this folder.

import { readFile } from "node:fs/promises";

/** Loads .env.development.local into process.env, without overriding
 * anything already set there. A missing file is fine. */
export async function loadEnvLocal() {
  try {
    const text = await readFile(new URL("../.env.development.local", import.meta.url), "utf8");
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
    // no .env.development.local, fall back to whatever is already in process.env
  }
}
