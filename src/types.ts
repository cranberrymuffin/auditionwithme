export type ContentLine =
  | { kind: "verbal"; text: string }
  | { kind: "nonverbal"; text: string };

export type Step = {
  speaker: string;
  verbalLine: string;
  content: ContentLine[];
};

export type SavedScript = {
  id: string;
  title: string;
  language_code: string;
  language_name: string;
  characters: string[];
  steps: Step[];
  pdf_path: string | null;
  content_hash: string | null;
  /** Confirmed casting from a past rehearsal, speaker → ElevenLabs voice id */
  character_voices: Record<string, string> | null;
  /** AI-director delivery tags, aligned by index with steps */
  delivery_tags: (string | null)[] | null;
  created_at: string;
};

export type Entitlement = {
  user_id: string;
  subscription_status: "free" | "active" | "past_due" | "canceled";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  free_sessions_used: number;
  free_sessions_limit: number;
};
