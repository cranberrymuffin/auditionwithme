/** Renders a line with word-by-word tracking states: said, the one the app
 * is waiting for, and still to come (the script page's .sides-word). */
export default function TrackedWords({
  text,
  matchedCount,
}: {
  text: string;
  matchedCount: number;
}) {
  const chunks = text.split(/(\s+)/);
  let wordIdx = 0;
  return (
    <>
      {chunks.map((chunk, i) => {
        if (/^\s+$/.test(chunk)) return chunk;
        const idx = wordIdx++;
        let cls = "sides-word";
        if (idx < matchedCount) cls = "sides-word is-said";
        else if (idx === matchedCount) cls = "sides-word is-current";
        return (
          <span key={i} className={cls}>
            {chunk}
          </span>
        );
      })}
    </>
  );
}
