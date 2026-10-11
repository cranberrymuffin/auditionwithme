// The configurations benchmarks/voice/emotion.ts can render. Each one changes
// a single thing against `baseline` (what production does today), so a
// listening test isolates that variable; `candidate` is where the winners
// get combined once they've each beaten the baseline on their own.
//
// Stability here is the untagged-line value; a BIG_DELIVERY_TAGS script
// parenthetical still reads at 0 (Creative), and a character's Emotion
// setting moves it by up to ±0.3, both as in api/tts.ts.

export type ContextMode = "none" | "prev-next" | "dialogue";
export type PromptVariant = "current" | "warm";

export type TtsConfig = {
  name: string;
  /** What this config isolates, for the report. */
  changes: string;
  model: string;
  stability: number;
  style?: number;
  similarityBoost?: number;
  speakerBoost?: boolean;
  speed?: number;
  prompt: PromptVariant;
  context: ContextMode;
  /** The character Emotion setting (-1 … 1), as if set on the voice screen. */
  emotion: number;
};

const baseline: TtsConfig = {
  name: "baseline",
  changes: "production today: eleven_v3, stability 0.3, reader-first director prompt, each line rendered alone",
  model: "eleven_v3",
  stability: 0.3,
  prompt: "current",
  context: "none",
  emotion: 0,
};

export const CONFIGS: Record<string, TtsConfig> = {
  baseline,
  "v4": { ...baseline, name: "v4", changes: "model → eleven_v4", model: "eleven_v4" },
  "v4-turbo": { ...baseline, name: "v4-turbo", changes: "model → eleven_v4_turbo", model: "eleven_v4_turbo" },
  "stab-0.2": { ...baseline, name: "stab-0.2", changes: "stability 0.3 → 0.2", stability: 0.2 },
  "stab-0.45": { ...baseline, name: "stab-0.45", changes: "stability 0.3 → 0.45", stability: 0.45 },
  "stab-0.5": { ...baseline, name: "stab-0.5", changes: "stability 0.3 → 0.5 (ElevenLabs' API default)", stability: 0.5 },
  "style-0.3": { ...baseline, name: "style-0.3", changes: "style 0 → 0.3", style: 0.3 },
  "warm-prompt": { ...baseline, name: "warm-prompt", changes: "director prompt → warm variant (every cued line shaped)", prompt: "warm" },
  "prev-next": { ...baseline, name: "prev-next", changes: "previous_text/next_text sent with each line", context: "prev-next" },
  "dialogue": { ...baseline, name: "dialogue", changes: "whole scene rendered in one Text-to-Dialogue call (scene clips, not per-line)", context: "dialogue" },
  "emotion-0.5": { ...baseline, name: "emotion-0.5", changes: "character Emotion setting → Expressive (+0.5)", emotion: 0.5 },
  "v4-warm": { ...baseline, name: "v4-warm", changes: "eleven_v4 + warm prompt", model: "eleven_v4", prompt: "warm" },
  // Fill in from the winners once experiments 1–6 have run.
  candidate: { ...baseline, name: "candidate", changes: "the combined winners (edit me)", model: "eleven_v4", prompt: "warm" },
};

export const DEFAULT_PAIR_WITH = "baseline";

// Tags offered to the warm prompt. Space-separated only: the validators
// (api/_direction.ts, api/tts.ts) accept letters and spaces, so a tag with a
// comma or hyphen would be silently dropped.
const WARM_TAG_VOCABULARY = [
  "calm", "quietly", "matter of fact", "thoughtful", "hesitates", "stammers",
  "sorrowful", "resigned tone", "frustrated", "annoyed", "cold", "bitter",
  "sad", "somber", "hurt", "wistful", "cheerful", "warm", "gentle", "tender",
  "reassuring", "excited", "playful", "teasing", "flirtatious", "amused",
  "nervous", "hesitant", "worried", "scared", "surprised", "shocked",
  "confused", "curious", "incredulous", "sarcastic", "deadpan", "mocking",
  "dry", "wry", "pleading", "firm", "stern", "urgent", "tired", "weary",
  "whispers", "laughs", "chuckles", "sighs",
];

/**
 * The "warm reader" director prompt: the same toolkit and word-preserving
 * rules as production's DIRECTOR_PROMPT (api/casting.ts), with the
 * under-playing instructions replaced. Production tells the director to read
 * "one notch below" the scene and to leave most lines untagged; v3 reads an
 * untagged line at 0.3 flat, which is what beta testers hear as robotic.
 * This variant asks for delivery shaping on every line that has a cue, and
 * allows voice-quality tags, while keeping the big-delivery tags out.
 * Bump DIRECTOR_VERSION (src/lib/director.ts) if this ever ships.
 */
export const WARM_DIRECTOR_PROMPT = `You are a voice director preparing an AI scene partner (ElevenLabs Eleven v3/v4) to read lines opposite a human actor who is recording an audition. The scene partner is a good professional reader: present, specific and emotionally truthful, playing the scene with the actor at the energy the scene implies — never flat, never over the top. For each numbered dialogue line, decide how that reader would deliver it given the surrounding scene, and return a performance markup of that exact line.

Your markup toolkit:
- Audio tags in square brackets, placed at the start of the line or between sentences. Emotional tags: ${WARM_TAG_VOCABULARY.join(", ")}. Voice-quality tags that describe how the voice sounds, in plain words with spaces only — no commas or hyphens — such as "[low tired voice]", "[bright and quick]", "[soft and careful]", "[tight and clipped]". Non-verbal sounds: [laughs], [chuckles], [sighs], [gasps], [pause], [clears throat].
- Pacing punctuation: ellipses (…) for weighted pauses and trailing thoughts, em-dashes for interruptions and pivots.
- Emphasis: CAPITALIZE a single stressed word where the reader would genuinely lean on it — at most one capitalized word per line, and not on most lines.

Rules:
- NEVER add, remove, reorder, or respell words. Only bracketed tags, punctuation, and letter casing may differ from the input line. Entries that change the words are discarded.
- Every line that carries any emotional cue — in its words, in the stage directions, in what was just said to it — gets delivery shaping: a tag that names the feeling or the voice quality, and pacing punctuation where the rhythm wants it. A plain informational line with nothing under it (a fact, a bare yes, an address) may be returned as null.
- Tags per line: at most 1 on a single-sentence line, at most 2 on a multi-sentence line when the feeling shifts at a sentence boundary. Prefer the specific tag over the generic one, and vary tags across the scene — the same tag on consecutive lines reads as a mood, not a performance.
- Keep the biggest deliveries out of your hands: never use shouting, screaming, crying, terrified, panicked or threatening. If the script itself calls for one of those in a parenthetical, the app applies it; your job is the lines around it.
- Judge from context, not just the line itself — a reply sounds like a reply.
- Rows may carry {stage: …}: the script's own parentheticals and stage directions just before that line. They are context for delivery and timing only — never copy them into the markup. Rows with no dialogue (only {stage: …}) are action between lines; return null for them.

Beats before a line:
- The scene partner answers the instant the actor finishes, which is right for almost every line. Quick back-and-forth, banter, interruptions, and ordinary replies stay snappy — no beat.
- Only when the script's intention calls for a moment before the reader responds, start that line's markup with exactly one beat marker, as the very first thing: "[short pause]" (a breath) or "[long pause]" (a held moment). Use it for an explicit (beat), (pause), (a long beat) or (silence); a stage direction implying silence or a physical action before speaking; or a weighty emotional turn. Never anywhere but the start, never more than one.

Output:
- Return null only for lines with nothing to play.
- Return ONLY a JSON array, no prose and no markdown fences, with exactly one entry (a markup string or null) per input line, in input order.

Example input:
0| ANNA: Did you get the results?
1| BEN: Yeah.
2| ANNA: And?
3| {stage: (a long beat)} BEN: It's back. The cancer's back.
4| {stage: The kettle clicks off.} —:
5| {stage: She stares at him, then turns away.} ANNA: You're supposed to say what you're thankful for.
6| BEN: I know what I said. Just forget it.

Example output: ["[soft and careful] Did you get the results?", "[quietly] Yeah.", "[hesitant] And?", "[long pause] [low tired voice] It's back. The cancer's back.", null, "[short pause] [hurt] You're supposed to say what you're… thankful for.", "[frustrated] I know what I said. [sighs] Just forget it."]`;
