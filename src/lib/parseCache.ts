// Saves one upload's parse to the script store the moment it arrives, so a
// reload or back-out before "Continue" can't lose it (and a re-upload finds
// it by content hash instead of paying for another parse). Kept free of
// storage imports so benchmarks/parse-cache.ts can drive it with fakes.
import type { Step } from "../types";

export type CachedParseFields = {
  steps: Step[];
  characters: string[];
  languageCode: string;
  languageName: string;
  /** Bilingual edition still waiting on the user's language pick. */
  needsLanguageChoice: boolean;
};

/** Returns a writer whose first successful call creates the row and every
 * later call updates that same row. Calls run strictly one after another,
 * so a quick Continue never lands before the row exists, and a repeated
 * call (StrictMode, a retry) never adds a second row. A failed create is
 * retried under the same id on the next call. */
export function createParseCache(deps: {
  /** Row already backing this session (replays) — every call updates it. */
  existingId?: string | null;
  newId: () => string;
  create: (id: string, fields: CachedParseFields) => Promise<void>;
  update: (id: string, fields: CachedParseFields) => Promise<void>;
  onCreated?: (id: string) => void;
  onError?: (err: unknown) => void;
}): (fields: CachedParseFields) => Promise<void> {
  let id = deps.existingId ?? null;
  let created = id !== null;
  let queue: Promise<void> = Promise.resolve();
  return (fields) => {
    queue = queue.then(async () => {
      try {
        if (created && id) {
          await deps.update(id, fields);
          return;
        }
        id ??= deps.newId();
        await deps.create(id, fields);
        created = true;
        deps.onCreated?.(id);
      } catch (err) {
        deps.onError?.(err);
      }
    });
    return queue;
  };
}
