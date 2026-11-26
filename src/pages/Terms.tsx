import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import TermsContent from "../components/TermsContent";
import { TERMS_TITLE } from "../lib/termsText";

export default function Terms() {
  return (
    <main className="page">
      <Seo
        title={TERMS_TITLE}
        description="The Terms and Conditions for using AuditionWithMe, the AI rehearsal partner for actors."
        path="/terms"
      />
      <SiteNav />

      <div className="wrap grid doc-layout">
        <header className="page-head doc-head span-4">
          <p className="slug">Legal</p>
          <h1 className="title">{TERMS_TITLE}</h1>
        </header>

        <article className="prose terms-body span-7 at-6">
          <TermsContent />
        </article>
      </div>

      <SiteFooter />
    </main>
  );
}
