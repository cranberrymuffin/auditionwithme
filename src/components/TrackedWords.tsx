/** Renders a line with word-by-word tracking states (said / current / unsaid). */
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
        let cls = "word--unsaid";
        if (idx < matchedCount) cls = "word--said";
        else if (idx === matchedCount) cls = "word--current";
        return (
          <span key={i} className={cls}>
            {chunk}
          </span>
        );
      })}
    </>
  );
}
