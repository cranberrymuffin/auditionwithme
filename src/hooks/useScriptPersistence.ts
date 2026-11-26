import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { Step } from "../types";
import { saveScript, updateScript } from "../lib/scriptStore";
import { hashFile } from "../lib/scriptHash";
import { createParseCache, type CachedParseFields } from "../lib/parseCache";
import { hasScriptPdf, saveScriptPdf } from "../lib/scriptPdfStore";
import { useToast } from "../lib/toast";

/** A parse as the script service (or a saved row) hands it over. */
export type ParseData = {
  steps?: Step[];
  characters?: string[];
  languageCode?: string;
  languageName?: string;
  /** Bilingual edition whose original-language text couldn't be extracted */
  unreadableOriginalLanguage?: boolean;
};

/**
 * Keeps a practice session's script on the account: the parse as it lands
 * (`cacheParse`), then its PDF and any rename once the row exists
 * (`scriptSaved`). Casting and direction are written by their own owners
 * (Practice, useDirectorTags) with updateScript.
 */
export function useScriptPersistence({
  user,
  file,
  scriptId,
  existingId,
  uploadContentHash,
}: {
  user: User | null;
  file: File | null;
  scriptId: string;
  /** The row already backing this session (a replay's). */
  existingId: string | undefined;
  /** Home.tsx already hashed this upload for its saved-script lookup. */
  uploadContentHash: string | null;
}) {
  const toast = useToast();
  // Casting and delivery tags are written back to the row as they settle.
  const [scriptSaved, setScriptSaved] = useState(() => Boolean(existingId));
  // Set when the actor renames the script (ScriptName on step 1).
  const [scriptTitle, setScriptTitle] = useState<string | null>(null);

  // Hashed once per upload, so re-uploading the same PDF later (Home.tsx's
  // handleFile) finds the saved row instead of paying for another parse.
  const contentHashRef = useRef<Promise<string | null> | null>(null);
  const getContentHash = () =>
    (contentHashRef.current ??= uploadContentHash
      ? Promise.resolve(uploadContentHash)
      : file
        ? hashFile(file).catch((err) => {
            // Saved without one: a re-upload of this PDF will be parsed again.
            console.warn("Couldn't hash the script's PDF:", err);
            return null;
          })
        : Promise.resolve(null));

  // Saves the parse to the account the moment it arrives — before Continue
  // or the language pick — so a reload or back-out can't lose it. The first
  // write creates the row; Continue, the language pick and an original-
  // language re-parse all update that same row (a replay's row from the
  // start). Unconfirmed parses show on My Account like any other script.
  const parseCacheRef = useRef<
    ((fields: CachedParseFields) => Promise<void>) | null
  >(null);
  const cacheParse = (data: ParseData, needsLanguageChoice: boolean) => {
    if (!user) return;
    const userId = user.id;
    parseCacheRef.current ??= createParseCache({
      existingId,
      newId: () => scriptId,
      create: async (id, fields) =>
        saveScript(userId, {
          id,
          // The PDF's own name, extension and all, until the actor renames it.
          title: file?.name ?? "Untitled script",
          ...fields,
          contentHash: await getContentHash(),
        }),
      update: (id, fields) => updateScript(id, fields),
      onCreated: () => setScriptSaved(true),
      onError: (err) => console.error("Failed to save script to account:", err),
    });
    void parseCacheRef.current({
      steps: data.steps ?? [],
      characters: data.characters ?? [],
      languageCode: data.languageCode ?? "en",
      languageName: data.languageName ?? "English",
      needsLanguageChoice,
    });
  };

  // Saved once the script has its record (the parse saves it as it lands,
  // so a rename made just before still gets there).
  useEffect(() => {
    if (!user || !scriptSaved || scriptTitle === null) return;
    void updateScript(scriptId, { title: scriptTitle }).catch((err) => {
      console.error("Failed to rename script:", err);
      toast("Couldn't rename that script. Please try again.");
    });
  }, [user, scriptId, scriptSaved, scriptTitle, toast]);

  // Keeps this script's PDF with it, so reopening it from My Auditions can
  // still show it (See script). Once the record exists; skipped if it's
  // already stored (a re-upload of a script that has one).
  useEffect(() => {
    if (!user || !scriptSaved || !file) return;
    let active = true;
    void hasScriptPdf(scriptId)
      .then((stored) =>
        stored || !active ? undefined : saveScriptPdf(scriptId, file),
      )
      .catch((err) => console.warn("Couldn't keep the script's PDF:", err));
    return () => {
      active = false;
    };
  }, [user, scriptId, scriptSaved, file]);

  return { scriptSaved, scriptTitle, setScriptTitle, cacheParse };
}
