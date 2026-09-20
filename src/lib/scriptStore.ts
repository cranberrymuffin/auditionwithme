// Permanent local store for parsed scripts — replaces the "scripts" Supabase
// table. Nothing here leaves the device: parsing still calls the AI endpoint
// (api/parse-script.ts), but the result is only ever persisted in IndexedDB.
import { SCRIPTS_STORE, withStore } from "./localDb";
import type { SavedScript, Step } from "../types";

type ScriptRecord = {
  id: string;
  userId: string;
  title: string;
  languageCode: string;
  languageName: string;
  characters: string[];
  steps: Step[];
  contentHash: string | null;
  characterVoices: Record<string, string> | null;
  deliveryTags: (string | null)[] | null;
  createdAt: string;
};

export type NewScript = {
  id: string;
  title: string;
  languageCode: string;
  languageName: string;
  characters: string[];
  steps: Step[];
  contentHash: string | null;
};

function toSavedScript(record: ScriptRecord): SavedScript {
  return {
    id: record.id,
    title: record.title,
    language_code: record.languageCode,
    language_name: record.languageName,
    characters: record.characters,
    steps: record.steps,
    content_hash: record.contentHash,
    character_voices: record.characterVoices,
    delivery_tags: record.deliveryTags,
    created_at: record.createdAt,
  };
}

export async function saveScript(userId: string, script: NewScript): Promise<void> {
  const record: ScriptRecord = {
    ...script,
    userId,
    characterVoices: {},
    deliveryTags: null,
    createdAt: new Date().toISOString(),
  };
  await withStore(SCRIPTS_STORE, "readwrite", (store) => store.put(record));
}

export async function listScripts(userId: string): Promise<SavedScript[]> {
  const all = await withStore<ScriptRecord[]>(SCRIPTS_STORE, "readonly", (store) =>
    store.getAll(),
  );
  return all
    .filter((record) => record.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toSavedScript);
}

/** Most recent saved script whose source PDF hashes the same as one already
 * on file, so a re-upload can reuse it instead of paying for another AI
 * parse — see scriptHash.ts and its callers in Home.tsx/Practice.tsx. */
export async function findScriptByContentHash(
  userId: string,
  contentHash: string,
): Promise<SavedScript | null> {
  const scripts = await listScripts(userId); // already newest-first
  return scripts.find((script) => script.content_hash === contentHash) ?? null;
}

export async function updateScript(
  id: string,
  patch: Partial<Pick<ScriptRecord, "characterVoices" | "deliveryTags">>,
): Promise<void> {
  const existing = await withStore<ScriptRecord | undefined>(
    SCRIPTS_STORE,
    "readonly",
    (store) => store.get(id),
  );
  if (!existing) return;
  await withStore(SCRIPTS_STORE, "readwrite", (store) =>
    store.put({ ...existing, ...patch }),
  );
}

export async function deleteScript(id: string): Promise<void> {
  await withStore(SCRIPTS_STORE, "readwrite", (store) => store.delete(id));
}
