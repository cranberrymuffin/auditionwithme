import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import { NDA_PARAGRAPHS, NDA_TITLE } from "../lib/ndaText";

// The Beta Tester NDA, linked from the signup checkbox during beta testing.
export default function Nda() {
  return (
    <main className="page">
      <Seo
        title={NDA_TITLE}
        description="The Beta Tester Non-Disclosure Agreement for AuditionWithMe."
        path="/nda"
      />
      <SiteNav />

      <div className="wrap grid doc-layout">
        <header className="page-head doc-head span-4">
          <p className="slug">Beta testing</p>
          <h1 className="title">{NDA_TITLE}</h1>
        </header>

        <article className="prose terms-body span-7 at-6">
          {NDA_PARAGRAPHS.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </article>
      </div>

      <SiteFooter />
    </main>
  );
}
