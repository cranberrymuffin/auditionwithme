import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sanitizePerformance } from "./_direction.js";
import { fetchVoices } from "./_elevenlabs.js";
import { requireAuthRateLimited } from "./_entitlement.js";

const client = new Anthropic();

const VOICE_CAST_SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          character: { type: "string" },
          voiceId: { type: "string" },
        },
        required: ["character", "voiceId"],
        additionalProperties: false,
      },
    },
  },
  required: ["assignments"],
  additionalProperties: false,
} as const;

// Chunked scanned-page parsing (parse-pages.ts) transcribes speaker names as
// printed, so the same character surfaces under several spellings across
// chunks ("WIDOW TWANKEY" / "WIDOW T" / "WIDOW T." plus OCR typos). This maps
// every raw name to a canonical one so the role picker shows one entry per
// character. Tiny call — names only, no script text.
const CANONICALIZE_SYSTEM_PROMPT = `You are given speaker names collected from different sections of ONE play script. Some entries are the same character written differently: abbreviations ("WIDOW T" for "WIDOW TWANKEY"), trailing initials or punctuation, or OCR typos. Others are genuinely distinct characters or group labels.

Return ONLY valid JSON mapping EVERY input name to its canonical form:
{"canonical": {"WIDOW T": "WIDOW TWANKEY", "WIDOW TWANKEY": "WIDOW TWANKEY", "ALADDIN": "ALADDIN"}}

Rules:
- Prefer the fullest spelling that appears in the input as the canonical form.
- Map obvious OCR typos to the correct name.
- Merge group-label duplicates (e.g. "EVERYONE"/"EVERYBODY" → one form).
- NEVER merge names that could plausibly be different characters.
- Every input name must appear exactly once as a key.`;

async function canonicalizeCharacters(req: VercelRequest, res: VercelResponse) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  const { characters } = (req.body ?? {}) as { characters?: string[] };
  if (!Array.isArray(characters) || characters.length === 0 || characters.length > 200 ||
      !characters.every((c) => typeof c === "string" && c.length <= 80)) {
    return res.status(400).json({ error: "No character names provided" });
  }

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system: CANONICALIZE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(characters) }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.type === "text" ? textBlock.text : "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: "Character matching failed" });
    }

    let parsed: { canonical?: Record<string, string> };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1)) as typeof parsed;
    } catch {
      return res.status(500).json({ error: "Character matching failed" });
    }

    const canonical: Record<string, string> = {};
    for (const name of characters) {
      const mapped = parsed.canonical?.[name];
      canonical[name] = typeof mapped === "string" && mapped ? mapped : name;
    }

    return res.status(200).json({ canonical });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Claude API error:", message);
    return res.status(500).json({ error: message });
  }
}

async function characterVoices(req: VercelRequest, res: VercelResponse) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenLabsKey) {
    return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
  }

  const { characters, languageCode = "en" } = (req.body ?? {}) as {
    characters: Array<{ name: string; sampleLines: string[] }>;
    languageCode?: string;
  };

  if (!Array.isArray(characters) || !characters.length || characters.some(
    (character) => !character || typeof character.name !== "string" || !Array.isArray(character.sampleLines)
  )) {
    return res.status(400).json({ error: "No characters provided" });
  }

  let allVoices;
  try {
    allVoices = await fetchVoices(elevenLabsKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice catalog unavailable";
    console.error("Voice catalog error:", message);
    return res.status(502).json({ error: "Voice catalog unavailable" });
  }
  if (!allVoices.length) {
    return res.status(502).json({ error: "No voices are available" });
  }
  const languageVoices = allVoices.filter((voice) => voice.language === languageCode);
  const VOICES = languageVoices.length ? languageVoices : allVoices;
  // Description included so the "prefer expressive voices" rule below has
  // real signal — tone labels alone rarely distinguish a characterful acting
  // voice from a flat narration one.
  const voiceList = VOICES.map(
    (v) =>
      `- ${v.name} (${[v.gender, v.age, v.accent, v.tone, v.description].filter(Boolean).join(", ")}) [id: ${v.id}]`
  ).join("\n");

  const characterList = characters
    .map((c) => `- ${c.name}: "${c.sampleLines.slice(0, 2).join(" / ")}"`)
    .join("\n");

  const prompt = `You are casting voices for a script reading app. Match each character to the most fitting voice based on their name, apparent gender, age, and dialogue style.

Available voices:
${voiceList}

Characters and sample lines:
${characterList}

Rules:
- The script language is ${languageCode}; only choose a voice from the supplied language-compatible list
- Assign a different voice to each character where possible
- Prioritise gender match, then age, then personality fit
- These voices act out scenes opposite a human, so prefer voices whose tone/description suggests expressive, emotionally versatile delivery (conversational, characterful) over flat narration or meditation voices
- Return one assignment for every character, using character names and voice IDs exactly as supplied

Example output: {"assignments":[{"character":"HAMLET","voiceId":"pNInz6obpgDQGcFmaJgB"},{"character":"OPHELIA","voiceId":"pFZP5JQG7iQjIQuC4Bku"}]}`;

  try {
    const response = await client.messages.parse({
      model: "claude-haiku-4-5-20251001",
      // Each assignment repeats a character name and voice ID. Scale the
      // allowance so a large cast cannot leave the JSON response unfinished.
      max_tokens: Math.min(8192, Math.max(1024, characters.length * 64)),
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: jsonSchemaOutputFormat(VOICE_CAST_SCHEMA),
      },
    });

    const assignments = response.parsed_output?.assignments;
    if (!assignments) throw new Error("No structured voice assignments in response");

    const characterNames = new Set(characters.map((character) => character.name));
    const voiceIds = new Set(VOICES.map((voice) => voice.id));
    const voices = Object.fromEntries(
      assignments
        .filter(({ character, voiceId }) => characterNames.has(character) && voiceIds.has(voiceId))
        .map(({ character, voiceId }) => [character, voiceId]),
    );
    return res.status(200).json({ voices });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Character voice matching error:", message);
    return res.status(500).json({ error: message });
  }
}

// Lines beyond this cap simply get no direction — the client aligns entries
// by index, so truncation degrades gracefully on very long scripts.
const MAX_LINES = 400;

// Emotional tags Eleven v3 handles well, offered to the director as the core
// palette (validation no longer requires them — sanitizePerformance keeps any
// simple bracketed tag and guarantees the spoken words are unchanged).
const TAG_VOCABULARY = [
  "angry", "annoyed", "cold", "sad", "somber", "crying", "cheerful", "warm",
  "excited", "playful", "teasing", "flirtatious", "nervous", "hesitant",
  "scared", "terrified", "surprised", "shocked", "confused", "curious",
  "sarcastic", "deadpan", "mocking", "threatening", "pleading", "desperate",
  "tired", "resigned", "whispers", "shouts", "laughs", "sighs",
];

const DIRECTOR_PROMPT = `You are a voice director preparing an AI scene partner (ElevenLabs Eleven v3) to read lines opposite a human actor. For each numbered dialogue line, decide how a skilled actor would deliver it given the surrounding scene, and return a performance markup of that exact line.

Your markup toolkit (Eleven v3):
- Audio tags in square brackets, placed at the start of the line or between sentences — emotional tags (${TAG_VOCABULARY.join(", ")}) and non-verbal sounds ([laughs], [chuckles], [sighs], [gasps], [pause], [clears throat]).
- Pacing punctuation: ellipses (…) for weighted pauses and trailing thoughts, em-dashes for interruptions and pivots.
- Emphasis: CAPITALIZE a single stressed word where a real actor would punch it.

Rules:
- NEVER add, remove, reorder, or respell words. Only bracketed tags, punctuation, and letter casing may differ from the input line. Entries that change the words are discarded.
- At most 2 audio tags per line. Don't front-load every line with an emotion tag — most conversational lines need only pacing punctuation, or nothing. Save emotional tags for lines where the scene clearly calls for them, and vary them; a scene where every line is tagged reads as melodrama.
- Judge from context, not just the line itself — a line's delivery depends on what was said before and where the scene is going.
- Return null for lines that are fine exactly as written.
- Return ONLY a JSON array, no prose and no markdown fences, with exactly one entry (a markup string or null) per input line, in input order.

Example output: [null, "[nervous] You're supposed to say what you're… thankful for.", null, "I KNOW what I said — [sighs] just forget it."]`;

function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

async function directLines(req: VercelRequest, res: VercelResponse) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  const { lines } = (req.body ?? {}) as {
    lines?: Array<{ speaker?: string; text?: string }>;
  };
  if (
    !Array.isArray(lines) ||
    !lines.length ||
    lines.some((line) => !line || typeof line !== "object")
  ) {
    return res.status(400).json({ error: "No lines provided" });
  }

  const capped = lines.slice(0, MAX_LINES);
  const numbered = capped
    .map(
      (line, index) =>
        `${index}| ${typeof line.speaker === "string" && line.speaker ? line.speaker : "—"}: ${typeof line.text === "string" ? line.text : ""}`,
    )
    .join("\n");

  try {
    const stream = client.messages.stream({
      model: "claude-opus-5",
      // The model echoes each directed line back with markup, so the output
      // budget scales with script length rather than tag count.
      max_tokens: 32000,
      // A well-specified per-line classification — low effort keeps latency
      // and cost down while adaptive thinking stays available for hard scenes.
      output_config: { effort: "low" },
      system: DIRECTOR_PROMPT,
      messages: [
        {
          role: "user",
          content: `Scene dialogue, one line per row:\n${numbered}`,
        },
      ],
    });
    const response = await stream.finalMessage();

    const textBlock = response.content.find((block) => block.type === "text");
    const json = extractJsonArray(
      textBlock?.type === "text" ? textBlock.text : "",
    );
    if (!json) {
      return res.status(500).json({ error: "Line direction failed" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return res.status(500).json({ error: "Line direction failed" });
    }
    if (!Array.isArray(parsed)) {
      return res.status(500).json({ error: "Line direction failed" });
    }

    // One entry per submitted line: markup that alters the spoken words, and
    // any overflow past the model's output (or MAX_LINES), collapses to null.
    // Kept under the `tags` key — it's the same wire/storage slot the old
    // single-word tags used, so saved scripts with either format keep working.
    const tags: (string | null)[] = lines.map((line, index) =>
      sanitizePerformance(parsed[index], typeof line.text === "string" ? line.text : ""),
    );

    return res.status(200).json({ tags });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Line direction error:", message);
    return res.status(500).json({ error: message });
  }
}

// Combines three Claude-driven casting/directing steps behind one route —
// keeps the function count under Vercel Hobby's 12-per-deployment cap.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuthRateLimited(req, res);
  if (!auth) return;

  const action = req.query.action;
  if (action === "canonicalize") return canonicalizeCharacters(req, res);
  if (action === "voices") return characterVoices(req, res);
  if (action === "direct-lines") return directLines(req, res);
  return res.status(400).json({ error: "Invalid or missing action" });
}
