import type { ReactNode } from "react";

// "AUDITIONWITHME" perched Hollywood-sign-style on the back hill ridge.
// Positions follow the ridge curve (rising left-to-right section near x≈790–1100
// of the 1440×300 viewBox), with per-letter stagger and tilt like the real sign.
// Each letter advances by its own approximate glyph width so kerning stays even.
const SIGN_FONT_SIZE = 26;
const GLYPH_W: Record<string, number> = { I: 9, T: 15, E: 16, H: 18, M: 24, W: 25 };
const SIGN_Y = [92, 94, 96, 97, 99, 100, 101, 102, 103, 105, 106, 108, 110, 112];
const SIGN_TILT = [-5, 3, -2, 4, -3, 2, -4, 3, -2, 4, -3, 2, -5, 3];
const SIGN_LETTERS = (() => {
  let x = 792;
  return "AUDITIONWITHME".split("").map((letter, i) => {
    const pos = { letter, x, y: SIGN_Y[i], tilt: SIGN_TILT[i] };
    x += (GLYPH_W[letter] ?? 18) + 4;
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
                  <line x1={x + w * 0.25} y1={y} x2={x + w * 0.25} y2={y + 10} stroke="var(--sign-letter)" strokeWidth={1.2} opacity={0.55} />
                  <line x1={x + w * 0.75} y1={y} x2={x + w * 0.75} y2={y + 10} stroke="var(--sign-letter)" strokeWidth={1.2} opacity={0.55} />
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
