import { useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";
import { IS_BETA_TESTING } from "../lib/beta";

const faqs = [
  [
    "What is a self-tape audition?",
    "A self-tape is a video audition you record yourself, usually at home, reading a scene from sides a casting director sent you, then submitting the recording instead of auditioning in person. Most film, TV, and commercial auditions now start with a self-tape, so being able to rehearse and record one cleanly matters as much as how you play the scene.",
  ],
  [
    "How do I record a self-tape audition with AuditionWithMe?",
    "Upload your PDF sides, choose the character you're reading, and start your rehearsal. Every other role in the scene is read aloud like a real scene partner so you can respond naturally, your own lines follow along on screen as you go, and your camera records a self-tape while you work through it. When you're happy with a take, download it from My Account and submit it for your audition.",
  ],
  [
    "Does AuditionWithMe use a teleprompter while I rehearse?",
    "Yes. As the scene plays, your lines track word by word on screen so you always know where you are, and you can look at the camera instead of down at a script. It works the same way while you're recording, so what you see while rehearsing is what you see while taping.",
  ],
  [
    "Does AuditionWithMe hold onto my files?",
    "Your script PDF is read once to generate the rehersal, then discarded.",
  ],
  [
    "Do I need to sign an NDA to use AuditionWithMe?",
    "Yes. You accept a confidentiality agreement when you create your account.",
  ],
  [
    "What file formats can I upload for my sides?",
    "AuditionWithMe currently parses PDF audition sides and scripts.",
  ],
  [
    "What browsers and devices does AuditionWithMe work best on?",
    "Chrome and Safari, on both desktop and mobile. Self-tape recording is built around mp4, which those browsers can capture, play back, and download directly; Firefox can't record mp4, so recording there falls back to a format the rest of the app isn't built around. On iPhone or iPad, add AuditionWithMe to your home screen from Safari instead of using it in a browser tab — Safari periodically clears locally stored data for sites you haven't opened in a while, and installing it as an app avoids that.",
  ],
  [
    "Is AuditionWithMe free to use?",
    IS_BETA_TESTING
      ? "AuditionWithMe is in beta, and rehearsals are unlimited and free with feedback for every account during this period."
      : "Your first three rehearsal sessions are free, no credit card required. After that, Audition Plus is $11 per month for unlimited rehearsals.",
  ],
] as const;

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map(([question, answer]) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: {
      "@type": "Answer",
      text: answer,
    },
  })),
};

export default function Faq() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <main className="faq-page">
      <Seo
        title="FAQ"
        description="Answers to common questions about recording self-tape auditions, rehearsing with a read-aloud scene partner, and how AuditionWithMe handles your scripts and self-tapes."
        path="/faq"
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <SiteNav />

      <section className="faq-hero">
        <p>Common questions</p>
        <h1>Frequently asked questions</h1>
        <div>
          Everything actors ask before their first self-tape, from how rehearsal
          works to what happens to your files.
        </div>
      </section>

      <section className="faq-list" aria-labelledby="faq-questions">
        <h2 id="faq-questions" className="sr-only">
          Questions and answers
        </h2>
        <div>
          {faqs.map(([question, answer], index) => (
            <details key={question} open={index === 0}>
              <summary>
                {question}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="faq-cta">
        <button
          type="button"
          className="upload-cta"
          onClick={() => navigate(user ? "/" : "/signup")}
        >
          <span className="upload-copy">
            {user ? (
              <>
                <strong>Upload your script</strong>
                <small>Rehearse your next scene</small>
              </>
            ) : (
              <>
                <strong>Sign up</strong>
                <small>
                  {IS_BETA_TESTING
                    ? "Beta test now"
                    : "Three rehearsals for free"}
                </small>
              </>
            )}
          </span>
          <span aria-hidden="true">→</span>
        </button>
      </section>
    </main>
  );
}
