export type Voice = {
  id: string;
  name: string;
  gender: string;
  age: string;
  accent: string;
  description: string;
  language: string;
  locale: string;
  tone: string;
};

export function describeVoice(v: Voice): string {
  return [v.accent, v.gender, v.age, v.tone].filter(Boolean).map(humanizeVoiceLabel).join(" · ");
}

export function voiceDisplayName(name: string): string {
  return name.split(/\s+-\s+/)[0].trim();
}

export function humanizeVoiceLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeSpeaker(name: string): string {
  return name
    .replace(/\s*\(cont['']?d\.?\)/gi, "")
    .replace(/\s*\(v\.?o\.?\)/gi, "")
    .replace(/\s*\(o\.?s\.?\)/gi, "")
    .replace(/\s*\(o\.?c\.?\)/gi, "")
    .replace(/\s*\(pre-lap\)/gi, "")
    .trim();
}

export function countMatchedWords(scriptWords: string[], transcript: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const spoken = transcript.toLowerCase().split(/\s+/).map(norm).filter(Boolean);
  const script = scriptWords.map(norm).filter(Boolean);
  let si = 0;
  for (let pi = 0; pi < spoken.length && si < script.length; pi++) {
    if (script[si] === spoken[pi]) si++;
  }
  return si;
}
