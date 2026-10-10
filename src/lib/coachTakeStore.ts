// The actor's own reads of scene partner lines, recorded on the coaching
// screen (CoachScenePartners.tsx) and kept on-device as recorded. Each take
// is re-voiced as its character by speech-to-speech (api/sts.ts) when the
// line is played; the result is reader audio like any other (keyed by the
// take's id, see ttsCacheKey.ts). Keeping the recording itself means a
// recast re-voices the same read rather than asking for it again.
import type { Step } from "../types";
import { COACH_TAKES_STORE, openDb, withStore } from "./localDb";
import { deleteByIndex } from "./readerAudioStore";

export type CoachTakeRecord = {
  /** Fresh for every recording, so a redo is a new reader-audio key. */
  id: string;
  scriptId: string;
  stepIndex: number;
  /** The line as it read when recorded; a take whose line has changed since
   * (a re-parse) no longer applies. */
  text: string;
  blob: Blob;
  /** blob.size, stored so size accounting never has to touch the blob. */
  size: number;
  createdAt: string;
};

export function loadCoachTakes(scriptId: string): Promise<CoachTakeRecord[]> {
  return withStore<CoachTakeRecord[]>(COACH_TAKES_STORE, "readonly", (store) =>
    store.index("scriptId").getAll(scriptId),
  );
}

export async function loadCoachTakeBlob(id: string): Promise<Blob | null> {
  const record = await withStore<CoachTakeRecord | undefined>(
    COACH_TAKES_STORE,
    "readonly",
    (store) => store.get(id),
  );
  return record?.blob ?? null;
}

/** Saves `record` as its line's one take, replacing any earlier take of the
 * same line in the same transaction. */
export async function saveCoachTake(record: CoachTakeRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(COACH_TAKES_STORE, "readwrite");
    const store = tx.objectStore(COACH_TAKES_STORE);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
    const existing = store.index("scriptId").getAll(record.scriptId);
    existing.onsuccess = () => {
      for (const take of existing.result as CoachTakeRecord[]) {
        if (take.stepIndex === record.stepIndex) store.delete(take.id);
      }
      store.put(record);
    };
  });
}

export async function deleteCoachTake(id: string): Promise<void> {
  await withStore(COACH_TAKES_STORE, "readwrite", (store) => store.delete(id));
}

export function deleteCoachTakesForScript(scriptId: string): Promise<number> {
  return deleteByIndex(COACH_TAKES_STORE, "scriptId", scriptId);
}

/** Step index → take id, for the takes whose line still reads as recorded. */
export function coachTakeMap(
  records: Pick<CoachTakeRecord, "id" | "stepIndex" | "text">[],
  steps: Step[],
): Record<number, string> {
  const map: Record<number, string> = {};
  for (const record of records) {
    if (steps[record.stepIndex]?.verbalLine === record.text) {
      map[record.stepIndex] = record.id;
    }
  }
  return map;
}
