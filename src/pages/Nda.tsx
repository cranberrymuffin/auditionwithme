import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import { NDA_PARAGRAPHS, NDA_TITLE } from "../lib/ndaText";

// The Beta Tester NDA, linked from the signup checkbox during beta testing.
export default function Nda() {
  return (
    <main className="faq-page">
      <Seo
        title={NDA_TITLE}
        description="The Beta Tester Non-Disclosure Agreement for AuditionWithMe."
        path="/nda"
      />
      <SiteNav />

      <section className="faq-hero">
        <h1>{NDA_TITLE}</h1>
      </section>

      <article className="terms-page terms-body">
        {NDA_PARAGRAPHS.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </article>
    </main>
  );
}
