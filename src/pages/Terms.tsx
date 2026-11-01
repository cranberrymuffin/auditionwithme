import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import TermsContent from "../components/TermsContent";
import { TERMS_TITLE } from "../lib/termsText";

export default function Terms() {
  return (
    <main className="faq-page">
      <Seo
        title={TERMS_TITLE}
        description="The Terms and Conditions for using AuditionWithMe, the AI rehearsal partner for actors."
        path="/terms"
      />
      <SiteNav />

      <section className="faq-hero">
        <h1>{TERMS_TITLE}</h1>
      </section>

      <article className="terms-page terms-body">
        <TermsContent />
      </article>
    </main>
  );
}
