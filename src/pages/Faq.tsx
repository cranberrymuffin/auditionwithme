import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import StartCta from "../components/marketing/StartCta";
import { IS_BETA_TESTING } from "../lib/beta";
import { TRIAL_DAYS } from "../lib/plan";

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
    "Yes. As the scene plays, your lines track on screen so you always know where you are, and you can look at the camera instead of down at a script. It works the same way while you're recording, so what you see while rehearsing is what you see while taping.",
  ],
  [
    "What happens to my script and my self-tapes?",
    "Your scripts and your self-tape videos are saved only on your device, in this browser or the app. They are never stored in our database. To make a rehearsal work, though, some of your material does leave your device to be processed. The text of your script (or images of its pages, if it's a scanned PDF) is sent to Anthropic, whose AI reads it into characters and lines. Your scene partners' lines, with a little of the dialogue around them, are sent to ElevenLabs to be turned into speech. While you rehearse, your microphone audio is streamed to ElevenLabs' speech recognition so the app can follow where you are in the scene. If you record a coaching take to show a scene partner how to say a line, that recording is sent to ElevenLabs too. We don't keep a copy of any of this; what Anthropic and ElevenLabs retain is governed by their own terms. Your self-tape video itself is not sent to us or to them: it stays on your device until you download or share it.",
  ],
  [
    "What do you store on your servers?",
    "Your account (your email and login), the agreement you accepted when you signed up, your subscription and billing status if you have one (card details go to Stripe, not to us), and any feedback you send: star ratings, comments, and some timing figures about how a take ran. None of that includes your script, your audio or your video.",
  ],
  [
    "Can I get to my scripts and takes from another device?",
    "No. Because they're saved only on the device you used, they don't follow you to another phone, computer or browser, and clearing this site's data (or deleting the app) removes them. Download any take you want to keep from My Account.",
  ],
  [
    "What file formats can I upload for my sides?",
    "AuditionWithMe currently parses PDF audition sides and scripts.",
  ],
  [
    "What browsers and devices does AuditionWithMe work best on?",
    "Chrome, Safari, or downloaded from the app store. Devices must have a working camera and microphone.",
  ],
  [
    "Is AuditionWithMe free to use?",
    IS_BETA_TESTING
      ? "AuditionWithMe is in beta, and rehearsals are unlimited and free with feedback for every account during this period."
      : `Audition Plus starts with a ${TRIAL_DAYS}-day free trial with unlimited rehearsals. Cancel before it ends and you won't be charged; otherwise it continues as a monthly subscription — see Pricing for the current price.`,
  ],
] as const;

/** Anchors other pages link to (e.g. signup's "What happens to your
 * script"), by question. */
const FAQ_IDS: Record<string, string> = {
  "What happens to my script and my self-tapes?": "your-script",
};

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

const PRICING_MENTION = "see Pricing";

/** Renders an answer, turning its "see Pricing" mention into a link to /pricing. */
function renderAnswer(answer: string) {
  const at = answer.indexOf(PRICING_MENTION);
  if (at === -1) return answer;
  return (
    <>
      {answer.slice(0, at)}see{" "}
      <Link className="link" to="/pricing">
        Pricing
      </Link>
      {answer.slice(at + PRICING_MENTION.length)}
    </>
  );
}

export default function Faq() {
  // A link to one answer (/faq#your-script) opens it and brings it into view.
  const { hash } = useLocation();
  const [linkedId, setLinkedId] = useState<string | null>(null);
  useEffect(() => {
    const id = hash.slice(1);
    if (!id || !Object.values(FAQ_IDS).includes(id)) return;
    setLinkedId(id);
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [hash]);

  return (
    <main className="page">
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

      <div className="wrap grid doc-layout">
        <header className="page-head doc-head span-4">
          <p className="slug">FAQ</p>
          <h1 className="title">Frequently asked questions</h1>
          <p className="lead">
            What actors ask before their first self-tape, from how rehearsal
            works to what happens to your data.
          </p>
        </header>

        <section className="span-7 at-6" aria-labelledby="faq-questions">
          <h2 id="faq-questions" className="sr-only">
            Questions and answers
          </h2>
          <div className="qa">
            {faqs.map(([question, answer], index) => (
              <details
                key={question}
                id={FAQ_IDS[question]}
                open={index === 0 || (linkedId !== null && FAQ_IDS[question] === linkedId) || undefined}
              >
                <summary>
                  {question}
                  <span className="qa-icon" aria-hidden="true" />
                </summary>
                <p>{renderAnswer(answer)}</p>
              </details>
            ))}
          </div>
        </section>
      </div>

      <section className="section closing" aria-labelledby="faq-closing-title">
        <div className="wrap">
          <h2 id="faq-closing-title" className="title">
            Try it with your own sides.
          </h2>
          <StartCta />
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
