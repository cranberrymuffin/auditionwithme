export type ContentLine =
  | { kind: "verbal"; text: string }
  | { kind: "nonverbal"; text: string };

export type Step = {
  speaker: string;
  verbalLine: string;
  content: ContentLine[];
};

/** A script as the app reads it back from the on-device store
 * (lib/scriptStore.ts), with the fields older rows lack filled in. */
export type SavedScript = {
  id: string;
  title: string;
  languageCode: string;
  languageName: string;
  characters: string[];
  steps: Step[];
  contentHash: string | null;
  /** Confirmed casting from a past rehearsal, speaker → ElevenLabs voice id */
  characterVoices: Record<string, string> | null;
  /** Scene partner levels from a past rehearsal, speaker → gain (1 = unity) */
  characterVolumes: Record<string, number> | null;
  characterEmotions: Record<string, number> | null;
  characterPaces: Record<string, number> | null;
  /** AI-director delivery tags, aligned by index with steps */
  deliveryTags: (string | null)[] | null;
  /** DIRECTOR_VERSION the delivery tags were generated under; null on rows
   * saved before versioning (treated as stale). */
  directorVersion: number | null;
  /** Characters the user has rehearsed as (read the human part for), so My
   * Auditions can offer "Practice as X" without re-casting every time. */
  rolesRead: string[];
  /** Bilingual edition parsed but its language not yet picked — replaying it
   * asks again instead of rehearsing the translation unasked. */
  needsLanguageChoice: boolean;
  createdAt: string;
};

/** A script Practice opens without parsing it again: a SavedScript, passed
 * in history state as navigate("/practice", { state: { replayScript } }).
 * Looser than SavedScript because history entries outlive the code that
 * wrote them. */
export type ReplayScript = {
  /** Saved row id — present so casting/direction updates land on the row. */
  id?: string;
  title: string;
  steps: Step[];
  characters: string[];
  languageCode: string;
  languageName: string;
  characterVoices?: Record<string, string> | null;
  characterVolumes?: Record<string, number> | null;
  characterEmotions?: Record<string, number> | null;
  characterPaces?: Record<string, number> | null;
  deliveryTags?: (string | null)[] | null;
  directorVersion?: number | null;
  rolesRead?: string[] | null;
  needsLanguageChoice?: boolean;
};

export type SelfTape = {
  id: string;
  script_id: string;
  /** Character the actor read for this take. Empty on tapes recorded before
   * this field existed, or when the actor chose "Skip". */
  role: string;
  created_at: string;
  /** Beta requirement: a rating (and comment, below 5 stars) owed before the
   * app stops blocking on it — see FeedbackGate.tsx. The rating/comment
   * themselves aren't kept locally; submitFeedback sends them straight to
   * the self_tape_feedback table in Supabase. */
  feedback_required: boolean;
  feedback_submitted_at: string | null;
};

export type Entitlement = {
  user_id: string;
  subscription_status: "free" | "active" | "past_due" | "canceled";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  free_sessions_used: number;
  free_sessions_limit: number;
  terms_version: string | null;
  terms_accepted_at: string | null;
  auto_renew_consent_at: string | null;
};
