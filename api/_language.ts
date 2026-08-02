// Deterministic dialogue-language detection via stopword scoring. Extensible:
// add a profile row to support another language. Falls back to English when no
// profile scores clearly.

const PROFILES: { code: string; name: string; words: Set<string> }[] = [
  { code: "en", name: "English", words: new Set(["the", "and", "you", "that", "have", "not", "with", "this", "what", "just", "your", "was", "don't", "it's", "i'm", "know", "like", "going", "right", "yeah"]) },
  { code: "fr", name: "French", words: new Set(["le", "la", "les", "et", "vous", "que", "pas", "des", "une", "est", "pour", "dans", "qui", "mais", "avec", "c'est", "je", "tu", "ne", "bien"]) },
  { code: "es", name: "Spanish", words: new Set(["el", "la", "los", "las", "que", "de", "y", "no", "es", "una", "por", "con", "para", "está", "pero", "como", "más", "muy", "qué", "usted"]) },
  { code: "de", name: "German", words: new Set(["der", "die", "das", "und", "ich", "nicht", "sie", "ist", "du", "wir", "ein", "eine", "mit", "was", "aber", "auch", "wie", "haben", "für", "ja"]) },
  { code: "it", name: "Italian", words: new Set(["il", "la", "che", "di", "non", "è", "una", "per", "con", "sono", "ma", "come", "questo", "hai", "cosa", "più", "anche", "bene", "gli", "della"]) },
  { code: "pt", name: "Portuguese", words: new Set(["o", "a", "os", "que", "de", "não", "é", "uma", "para", "com", "por", "mas", "como", "você", "isso", "mais", "muito", "bem", "está", "são"]) },
  { code: "nl", name: "Dutch", words: new Set(["de", "het", "een", "en", "ik", "niet", "je", "dat", "is", "van", "op", "zijn", "maar", "met", "voor", "wat", "dit", "als", "ook", "naar"]) },
];

export function detectLanguage(text: string): { code: string; name: string } {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .filter(Boolean)
    .slice(0, 4000);
  if (words.length < 20) return { code: "en", name: "English" };

  let best = PROFILES[0];
  let bestScore = 0;
  for (const profile of PROFILES) {
    let score = 0;
    for (const word of words) if (profile.words.has(word)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }
  // Require a minimal stopword density to trust the result.
  if (bestScore / words.length < 0.05) return { code: "en", name: "English" };
  return { code: best.code, name: best.name };
}
