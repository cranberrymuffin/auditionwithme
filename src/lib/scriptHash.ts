// Content fingerprint for uploaded script PDFs, used to detect re-uploads of
// a script already parsed and saved for this user so we can skip the
// parse-script AI call and serve the stored steps instead.
export async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
