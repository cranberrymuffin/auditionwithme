export type ContentLine =
  | { kind: "verbal"; text: string }
  | { kind: "nonverbal"; text: string };

export type Step = {
  speaker: string;
  verbalLine: string;
  content: ContentLine[];
};
