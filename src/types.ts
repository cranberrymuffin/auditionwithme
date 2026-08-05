export type ContentLine =
  | { kind: "verbal"; text: string }
  | { kind: "nonverbal"; text: string };

export type Step = {
  speaker: string;
  verbalLine: string;
  content: ContentLine[];
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
