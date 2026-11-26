// The Claude models every route uses, in one place so a model upgrade is one
// edit. Each call site still owns its own thinking/effort settings.

/** Vision transcription, the full script parse and the line director. */
export const SONNET_MODEL = "claude-sonnet-5-5";

/** Small classification calls: script structure, name canonicalization,
 * voice casting and the semantic line match. */
export const HAIKU_MODEL = "claude-haiku-5-5";
