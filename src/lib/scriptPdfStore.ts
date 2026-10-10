// Each saved script's own PDF, kept on-device so reopening it from My
// Auditions can still show the script on step 1 (See script). In a store of
// its own rather than on the script record, so listing scripts never reads
// the PDFs. Deleted with its script (scriptStore.deleteScript).
import { SCRIPT_PDFS_STORE, withStore } from "./localDb";

type ScriptPdfRecord = { scriptId: string; file: File };

export async function saveScriptPdf(scriptId: string, file: File): Promise<void> {
  await withStore(SCRIPT_PDFS_STORE, "readwrite", (store) =>
    store.put({ scriptId, file } satisfies ScriptPdfRecord),
  );
}

/** The script's PDF, or null if it has none (saved before PDFs were kept). */
export async function loadScriptPdf(scriptId: string): Promise<File | null> {
  const record = await withStore<ScriptPdfRecord | undefined>(SCRIPT_PDFS_STORE, "readonly", (store) =>
    store.get(scriptId),
  );
  return record?.file ?? null;
}

/** Whether the script has its PDF stored, without reading the PDF. */
export async function hasScriptPdf(scriptId: string): Promise<boolean> {
  const count = await withStore<number>(SCRIPT_PDFS_STORE, "readonly", (store) => store.count(scriptId));
  return count > 0;
}

export async function deleteScriptPdf(scriptId: string): Promise<void> {
  await withStore(SCRIPT_PDFS_STORE, "readwrite", (store) => store.delete(scriptId));
}
