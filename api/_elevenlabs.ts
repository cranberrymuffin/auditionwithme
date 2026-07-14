export type Voice = {
  id: string;
  name: string;
  gender: string;
  age: string;
  accent: string;
  description: string;
};

export async function fetchVoices(apiKey: string): Promise<Voice[]> {
  const upstream = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
    headers: { "xi-api-key": apiKey },
  });

  if (!upstream.ok) {
    throw new Error(`ElevenLabs voices fetch failed: ${await upstream.text()}`);
  }

  const data = await upstream.json();
  return (data.voices ?? []).map((v: any) => ({
    id: v.voice_id,
    name: v.name,
    gender: v.labels?.gender ?? "neutral",
    age: v.labels?.age ?? "",
    accent: v.labels?.accent ?? "",
    description: v.labels?.description ?? v.labels?.use_case ?? "",
  }));
}
