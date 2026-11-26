import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import HowSteps from "../components/marketing/HowSteps";
import StartCta from "../components/marketing/StartCta";

// What a rehearsal needs, as the FAQ states it (src/pages/Faq.tsx).
const needs = [
  ["Your sides", "A PDF of your audition sides or script."],
  ["A browser or the app", "Chrome or Safari, or the app from the App Store."],
  ["Camera and microphone", "The microphone follows your lines; the camera records the self-tape."],
];

export default function About() {
  return (
    <main className="page">
      <Seo
        title="How It Works"
        description="Upload your sides, choose your role, and rehearse with every other character read aloud while your lines follow along on screen. Record a self-tape as you go and download it to submit for your audition."
        path="/how-it-works"
      />
      <SiteNav />

      <header className="wrap page-head">
        <p className="slug">How it works</p>
        <h1 className="title">From your sides to a self-tape, in four steps.</h1>
        <p className="lead">
          Upload your sides, choose your role, and rehearse with every other
          character read aloud while your lines follow along on screen.
          Record a self-tape as you go, then download it to submit for your
          audition.
        </p>
      </header>

      <section className="wrap" aria-labelledby="how-it-works-title">
        <h2 id="how-it-works-title" className="sr-only">
          The four steps
        </h2>
        <HowSteps layout="rows" />
      </section>

      <section className="section" aria-labelledby="how-needs-title">
        <div className="wrap grid">
          <header className="section-head span-4">
            <p className="slug">Before you start</p>
            <h2 id="how-needs-title" className="title">
              What you need.
            </h2>
          </header>
          <dl className="spec-list span-7 at-6">
            {needs.map(([term, detail]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="section closing" aria-labelledby="how-closing-title">
        <div className="wrap">
          <h2 id="how-closing-title" className="title">
            Try it with your own sides.
          </h2>
          <StartCta />
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
