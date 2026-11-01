import { normalizeTag } from "./direction";

// Scores the on-device director (onDeviceDirector.ts) against the cloud
// director's markup for the same lines. The Admin page runs it in the iOS
// app over saved scripts that already carry cloud markup, so the check
// costs no API calls. Proxies, not a verdict: the gate below catches a
// director that breaks lines, over-acts, or misses the script's beats, and
// a listen decides the rest.

const BEAT = /^\[(short|long) pause\]/;

function tagsOf(markup: string | null): Set<string> {
  const tags = new Set<string>();
  for (const [, inner] of (markup ?? "").matchAll(/\[([^\]]*)\]/g)) {
    const tag = normalizeTag(inner);
    if (tag && tag !== "short pause" && tag !== "long pause") tags.add(tag);
  }
  return tags;
}

export type DirectorComparison = {
  /** Lines with words to speak. */
  lines: number;
  /** Entries the on-device model returned, and how many survived
   * validation (right row, same spoken words). */
  returned: number;
  kept: number;
  /** Share of lines each director marked up at all. */
  cloudDirectedRate: number;
  onDeviceDirectedRate: number;
  /** Share of lines where both marked up, or both left alone. */
  directedAgreement: number;
  /** Beat markers: of the cloud's beats, how many on-device also placed
   * (recall), and of on-device's beats, how many the cloud agreed with. */
  beatRecall: number | null;
  beatPrecision: number | null;
  /** Mean overlap (Jaccard) of the emotion tags on lines both tagged. */
  tagOverlap: number | null;
};

export function compareDirectors(
  texts: string[],
  cloud: (string | null)[],
  onDevice: (string | null)[],
  counts: { returned: number; kept: number },
): DirectorComparison {
  let lines = 0;
  let cloudDirected = 0;
  let onDeviceDirected = 0;
  let agree = 0;
  let cloudBeats = 0;
  let onDeviceBeats = 0;
  let sharedBeats = 0;
  let overlapSum = 0;
  let overlapLines = 0;
  texts.forEach((text, i) => {
    if (!text.trim()) return;
    lines++;
    const a = cloud[i] ?? null;
    const b = onDevice[i] ?? null;
    if (a) cloudDirected++;
    if (b) onDeviceDirected++;
    if (!!a === !!b) agree++;
    const beatA = !!a && BEAT.test(a);
    const beatB = !!b && BEAT.test(b);
    if (beatA) cloudBeats++;
    if (beatB) onDeviceBeats++;
    if (beatA && beatB) sharedBeats++;
    const tagsA = tagsOf(a);
    const tagsB = tagsOf(b);
    if (tagsA.size && tagsB.size) {
      const shared = [...tagsA].filter((tag) => tagsB.has(tag)).length;
      overlapSum += shared / new Set([...tagsA, ...tagsB]).size;
      overlapLines++;
    }
  });
  return {
    lines,
    returned: counts.returned,
    kept: counts.kept,
    cloudDirectedRate: lines ? cloudDirected / lines : 0,
    onDeviceDirectedRate: lines ? onDeviceDirected / lines : 0,
    directedAgreement: lines ? agree / lines : 0,
    beatRecall: cloudBeats ? sharedBeats / cloudBeats : null,
    beatPrecision: onDeviceBeats ? sharedBeats / onDeviceBeats : null,
    tagOverlap: overlapLines ? overlapSum / overlapLines : null,
  };
}

/** Pools per-script comparisons, weighting each by its lines. */
export function poolComparisons(results: DirectorComparison[]): DirectorComparison {
  const lines = results.reduce((sum, r) => sum + r.lines, 0);
  const weighted = (pick: (r: DirectorComparison) => number | null) => {
    const usable = results.filter((r) => pick(r) !== null && r.lines);
    const weight = usable.reduce((sum, r) => sum + r.lines, 0);
    return weight ? usable.reduce((sum, r) => sum + pick(r)! * r.lines, 0) / weight : null;
  };
  return {
    lines,
    returned: results.reduce((sum, r) => sum + r.returned, 0),
    kept: results.reduce((sum, r) => sum + r.kept, 0),
    cloudDirectedRate: weighted((r) => r.cloudDirectedRate) ?? 0,
    onDeviceDirectedRate: weighted((r) => r.onDeviceDirectedRate) ?? 0,
    directedAgreement: weighted((r) => r.directedAgreement) ?? 0,
    beatRecall: weighted((r) => r.beatRecall),
    beatPrecision: weighted((r) => r.beatPrecision),
    tagOverlap: weighted((r) => r.tagOverlap),
  };
}

export type GateCheck = { name: string; pass: boolean; detail: string };

const pct = (value: number) => `${Math.round(value * 100)}%`;

/**
 * The bar the on-device director has to clear before
 * VITE_ON_DEVICE_DIRECTOR is turned on (then a listen):
 * - its markup survives validation — it doesn't rewrite the actor's script;
 * - it doesn't over-act: a reader who tags every line out-acts the actor,
 *   which beta testers hear as melodrama;
 * - it finds the script's beats, and doesn't invent many of its own.
 */
export function directorGate(pooled: DirectorComparison): GateCheck[] {
  const validity = pooled.returned ? pooled.kept / pooled.returned : 1;
  const maxDirected = Math.max(pooled.cloudDirectedRate * 1.5, pooled.cloudDirectedRate + 0.1);
  return [
    {
      name: "Keeps the script's words",
      pass: validity >= 0.9,
      detail: `${pct(validity)} of its markup passed validation (needs 90%)`,
    },
    {
      name: "Doesn't over-act",
      pass: pooled.onDeviceDirectedRate <= maxDirected,
      detail: `marks up ${pct(pooled.onDeviceDirectedRate)} of lines; cloud ${pct(pooled.cloudDirectedRate)} (limit ${pct(maxDirected)})`,
    },
    {
      name: "Finds the script's beats",
      pass: pooled.beatRecall === null || pooled.beatRecall >= 0.5,
      detail: pooled.beatRecall === null ? "the cloud placed no beats" : `${pct(pooled.beatRecall)} of the cloud's beats (needs 50%)`,
    },
    {
      name: "Doesn't invent beats",
      pass: pooled.beatPrecision === null || pooled.beatPrecision >= 0.5,
      detail:
        pooled.beatPrecision === null
          ? "placed no beats"
          : `${pct(pooled.beatPrecision)} of its beats match the cloud's (needs 50%)`,
    },
  ];
}
