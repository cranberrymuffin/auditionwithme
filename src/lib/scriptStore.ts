// Permanent local store for parsed scripts — replaces the "scripts" Supabase
// table. Nothing here leaves the device: parsing still calls the AI endpoint
// (api/parse-script.ts), but the result is only ever persisted in IndexedDB.
import { SCRIPTS_STORE, withStore, withStoreReadModifyWrite } from "./localDb";
import { deleteReaderAudioForScript } from "./readerAudioStore";
import { deleteScriptPdf } from "./scriptPdfStore";
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
  /** Missing on rows saved before per-character levels existed. */
  characterVolumes?: Record<string, number>;
  deliveryTags: (string | null)[] | null;
  /** DIRECTOR_VERSION (src/lib/director.ts) the deliveryTags came from;
   * missing on rows saved before versioning, which readers treat as stale. */
  directorVersion?: number;
  /** Characters the user has rehearsed as; missing on rows saved before this
   * field existed, so readers fall back to an empty list. */
  rolesRead?: string[];
  /** Bilingual edition saved before the user picked which language to
   * rehearse (steps hold the translation). Missing on older rows and on
   * every normal script, which readers treat as "already chosen". */
  needsLanguageChoice?: boolean;
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
  needsLanguageChoice?: boolean;
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
    character_volumes: record.characterVolumes ?? null,
    delivery_tags: record.deliveryTags,
    director_version: record.directorVersion ?? null,
    roles_read: record.rolesRead ?? [],
    needs_language_choice: record.needsLanguageChoice ?? false,
    created_at: record.createdAt,
  };
}

export async function saveScript(userId: string, script: NewScript): Promise<void> {
  const record: ScriptRecord = {
    ...script,
    userId,
    characterVoices: {},
    deliveryTags: null,
    rolesRead: [],
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
  patch: Partial<
    Pick<
      ScriptRecord,
      | "characterVoices"
      | "characterVolumes"
      | "deliveryTags"
      | "directorVersion"
      | "rolesRead"
      | "steps"
      | "characters"
      | "languageCode"
      | "languageName"
      | "needsLanguageChoice"
    >
  >,
): Promise<void> {
  await withStoreReadModifyWrite<ScriptRecord>(SCRIPTS_STORE, id, (existing) => ({
    ...existing,
    ...patch,
  }));
}

export async function deleteScript(id: string): Promise<void> {
  await withStore(SCRIPTS_STORE, "readwrite", (store) => store.delete(id));
  // Its pre-generated reader audio goes with it, in a separate transaction:
  // the script is already gone either way, so a failure here only leaves
  // orphaned audio for the storage cap to sweep up later.
  try {
    await deleteReaderAudioForScript(id);
  } catch (err) {
    console.warn("Couldn't delete the script's stored reader audio:", err);
  }
  // Likewise its PDF (scriptPdfStore.ts).
  try {
    await deleteScriptPdf(id);
  } catch (err) {
    console.warn("Couldn't delete the script's stored PDF:", err);
  }
}
