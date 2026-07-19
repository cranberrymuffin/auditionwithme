import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";

const features = [
  "Choose a voice for every character",
  "Rehearse complete scripts",
  "Follow dialogue word by word",
  "Save your selected role and setup",
  "Replay scenes throughout your plan",
];

const questions = [
  ["What counts as a rehearsal session?", "One uploaded PDF prepared as a new rehearsal. Replaying or revisiting that same rehearsal does not create another session."],
  ["Do I need a credit card to start?", "No. Your first three rehearsal sessions are included without a credit card."],
  ["What happens after my free sessions?", "You can continue creating new rehearsals with Audition Plus for $7 per month."],
  ["Can I cancel anytime?", "Yes. The plan renews monthly, and you can cancel before your next renewal."],
  ["What files can I upload?", "The rehearsal parser currently accepts PDF audition sides and scripts."],
  ["How is my script handled?", "Your PDF is processed to identify dialogue, characters, and scene directions needed for the rehearsal."],
];

export default function Pricing() {
  const navigate = useNavigate();

  return (
    <main className="pricing-page">
      <SiteNav />

      <section className="pricing-main">
        <div className="pricing-intro">
          <p>One simple plan</p>
          <h1>Simple pricing for serious rehearsal</h1>
          <div>Start with three free sessions. Upgrade only when rehearsal becomes part of your routine.</div>
          <ul className="pricing-reassurance">
            <li><span>✓</span>No credit card to start</li>
            <li><span>✓</span>Cancel anytime</li>
            <li><span>✓</span>PDF scripts supported</li>
          </ul>
        </div>

        <article className="pricing-card">
          <header><div><p>Audition Plus</p><span>For regular scene work</span></div><span>One plan</span></header>
          <p className="plan-description">Everything you need to rehearse complete scenes with a responsive scene partner.</p>
          <p className="plan-price" aria-label="Seven dollars per month"><strong>$7</strong><span>/month</span></p>
          <p className="free-allowance">Your first three rehearsal sessions are free.</p>
          <ul>
            {features.map((feature) => <li key={feature}><span aria-hidden="true">✓</span>{feature}</li>)}
          </ul>
          <button onClick={() => navigate("/")}>Start rehearsing free <span>→</span></button>
          <footer><strong>3 sessions included.</strong> No credit card required.</footer>
        </article>
      </section>

      <section className="pricing-details" aria-labelledby="pricing-questions">
        <header><p>Before you begin</p><h2 id="pricing-questions">Plan details</h2></header>
        <div>
          {questions.map(([question, answer], index) => (
            <details key={question} open={index === 0}>
              <summary>{question}<span aria-hidden="true">+</span></summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="pricing-footer"><span>Audition With Me</span><span>Questions about the plan? Contact support before subscribing.</span></footer>
    </main>
  );
}
