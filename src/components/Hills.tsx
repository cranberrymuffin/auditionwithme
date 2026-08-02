import type { ReactNode } from "react";

// "AUDITIONWITHME" perched Hollywood-sign-style on the back hill ridge.
// Each letter's baseline is computed from the actual back-hill bezier (x≈790–1100
// of the 1440×300 viewBox) so the stilts always stand planted in the hill, with
// per-letter stagger and tilt like the real sign. Each letter advances by its own
// approximate glyph width so kerning stays even.
const SIGN_FONT_SIZE = 26;
const STILT_H = 10;
const SIGN_SINK = 2.5; // stilt feet sink slightly into the ridge so tilt never lifts them off
const GLYPH_W: Record<string, number> = { I: 9, T: 15, E: 16, H: 18, M: 24, W: 25 };
const SIGN_TILT = [-5, 3, -2, 4, -3, 2, -4, 3, -2, 4, -3, 2, -5, 3];

const cubicAt = (a: number, b: number, c: number, d: number, t: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;

// Back-hill ridge segments — keep in sync with the first <path> d below.
const RIDGE: [number, number][][] = [
  [[0, 180], [200, 80], [480, 240], [720, 140]],
  [[720, 140], [960, 40], [1200, 160], [1440, 120]],
];

/** y of the back-hill ridge at a given x (x is monotonic within each segment). */
function ridgeYAt(x: number): number {
  const [p0, p1, p2, p3] = x <= 720 ? RIDGE[0] : RIDGE[1];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (cubicAt(p0[0], p1[0], p2[0], p3[0], mid) < x) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return cubicAt(p0[1], p1[1], p2[1], p3[1], t);
}

const SIGN_LETTERS = (() => {
  let x = 792;
  return "AUDITIONWITHME".split("").map((letter, i) => {
    const w = GLYPH_W[letter] ?? 18;
    const y = ridgeYAt(x + w / 2) - STILT_H + SIGN_SINK;
    const pos = { letter, x, y, tilt: SIGN_TILT[i] };
    x += w + 4;
    return pos;
  });
})();

type HillsProps = {
  children?: ReactNode;
  /** Hide the Hollywood sign (e.g. compact rehearsal footer) */
  noSign?: boolean;
  className?: string;
};

export default function Hills({ children, noSign = false, className = "" }: HillsProps) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 h-[clamp(160px,32vh,300px)] ${className}`}
    >
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 1440 300"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Back hill */}
        <path
          d="M0,180 C200,80 480,240 720,140 C960,40 1200,160 1440,120 L1440,300 L0,300 Z"
          fill="var(--hill-back)"
        />

        {/* Hollywood sign on the back ridge */}
        {!noSign && (
          <g
            className="hidden md:inline"
            style={{ filter: "var(--sign-fx)" }}
            fontFamily="var(--font-sans)"
            fontWeight={800}
            fontSize={SIGN_FONT_SIZE}
            fill="var(--sign-letter)"
          >
            {SIGN_LETTERS.map(({ letter, x, y, tilt }, i) => {
              const w = GLYPH_W[letter] ?? 18;
              return (
                <g key={i} transform={`rotate(${tilt} ${x + w / 2} ${y})`}>
                  {/* stilts */}
                  <line x1={x + w * 0.25} y1={y} x2={x + w * 0.25} y2={y + STILT_H} stroke="var(--sign-letter)" strokeWidth={1.2} opacity={0.55} />
                  <line x1={x + w * 0.75} y1={y} x2={x + w * 0.75} y2={y + STILT_H} stroke="var(--sign-letter)" strokeWidth={1.2} opacity={0.55} />
                  <text x={x} y={y}>{letter}</text>
                </g>
              );
            })}
          </g>
        )}

        {/* Front hill */}
        <path
          d="M0,240 C240,180 480,280 720,220 C960,160 1200,260 1440,220 L1440,300 L0,300 Z"
          fill="var(--hill-front)"
        />
      </svg>

      {children && (
        <div className="pointer-events-auto absolute inset-x-0 bottom-[12%] flex justify-center">
          {children}
        </div>
      )}
    </div>
  );
}
