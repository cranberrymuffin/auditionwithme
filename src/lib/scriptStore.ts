// Permanent local store for parsed scripts — replaces the "scripts" Supabase
// table. Nothing here leaves the device: parsing still calls the AI endpoint
// (api/parse-script.ts), but the result is only ever persisted in IndexedDB.
import { SCRIPTS_STORE, withStore, withStoreReadModifyWrite } from "./localDb";
import { deleteReaderAudioForScript } from "./readerAudioStore";
import { deleteCoachTakesForScript } from "./coachTakeStore";
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
  /** Missing on rows saved before per-character emotion and pace existed. */
  characterEmotions?: Record<string, number>;
  characterPaces?: Record<string, number>;
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

/** The stored row as the app reads it: the owner dropped, and the fields
 * older rows lack filled in. */
function toSavedScript(record: ScriptRecord): SavedScript {
  return {
    id: record.id,
    title: record.title,
    languageCode: record.languageCode,
    languageName: record.languageName,
    characters: record.characters,
    steps: record.steps,
    contentHash: record.contentHash,
    characterVoices: record.characterVoices,
    characterVolumes: record.characterVolumes ?? null,
    characterEmotions: record.characterEmotions ?? null,
    characterPaces: record.characterPaces ?? null,
    deliveryTags: record.deliveryTags,
    directorVersion: record.directorVersion ?? null,
    rolesRead: record.rolesRead ?? [],
    needsLanguageChoice: record.needsLanguageChoice ?? false,
    createdAt: record.createdAt,
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
  return scripts.find((script) => script.contentHash === contentHash) ?? null;
}

/** The user's saved script by id, else by its PDF's content hash. */
export async function findSavedScript(
  userId: string,
  { id, contentHash }: { id?: string | null; contentHash?: string | null },
): Promise<SavedScript | null> {
  if (!id && !contentHash) return null;
  const scripts = await listScripts(userId);
  return (
    (id && scripts.find((script) => script.id === id)) ||
    (contentHash && scripts.find((script) => script.contentHash === contentHash)) ||
    null
  );
}

export async function updateScript(
  id: string,
  patch: Partial<
    Pick<
      ScriptRecord,
      | "title"
      | "characterVoices"
      | "characterVolumes"
      | "characterEmotions"
      | "characterPaces"
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
  // Likewise its coached takes (coachTakeStore.ts) and its PDF
  // (scriptPdfStore.ts).
  try {
    await deleteCoachTakesForScript(id);
  } catch (err) {
    console.warn("Couldn't delete the script's coached takes:", err);
  }
  try {
    await deleteScriptPdf(id);
  } catch (err) {
    console.warn("Couldn't delete the script's stored PDF:", err);
  }
}
