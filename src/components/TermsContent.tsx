import { TERMS_BLOCKS, TERMS_UPDATED } from "../lib/termsText";

// Renders the Terms and Conditions body for the /terms page.
export default function TermsContent() {
  return (
    <>
      <p className="terms-updated">Last updated: {TERMS_UPDATED}</p>
      {TERMS_BLOCKS.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return <h3 key={index}>{block.text}</h3>;
          case "list":
            return (
              <ul key={index}>
                {block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            );
          case "address":
            return (
              <address key={index}>
                {block.lines.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </address>
            );
          default:
            return (
              <p key={index}>
                {block.lead && <strong>{block.lead} </strong>}
                {block.text}
              </p>
            );
        }
      })}
    </>
  );
}
