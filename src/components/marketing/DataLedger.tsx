import { Link } from "react-router-dom";

// Where an actor's material goes, as a ledger. Every statement here restates
// the FAQ's "What happens to my script and my self-tapes?" and "What do you
// store on your servers?" answers (src/pages/Faq.tsx): change them together.
export default function DataLedger() {
  return (
    <div className="ledger">
      <section>
        <h3 className="slug">Stays on your device</h3>
        <div>
          <ul>
            <li>Your scripts</li>
            <li>Your self-tape videos</li>
          </ul>
          <p>
            Saved only in this browser or the app, never in our database. They
            don’t follow you to another device, so download any take you want
            to keep.
          </p>
        </div>
      </section>
      <section>
        <h3 className="slug">Sent out to be processed</h3>
        <div>
          <ul>
            <li>
              The text of your script, or images of its pages if it’s a
              scanned PDF, goes to Anthropic, whose AI reads it into
              characters and lines.
            </li>
            <li>
              Your scene partners’ lines, with a little of the dialogue around
              them, go to ElevenLabs to be turned into speech.
            </li>
            <li>
              Your microphone audio is streamed to ElevenLabs’ speech
              recognition while you rehearse, so the app can follow where you
              are in the scene.
            </li>
            <li>
              A coaching take, if you record one to show a scene partner how
              to say a line, goes to ElevenLabs too.
            </li>
          </ul>
          <p>
            We don’t keep a copy of any of this. What Anthropic and ElevenLabs
            retain is governed by their own terms. Your self-tape video is not
            sent to us or to them.
          </p>
        </div>
      </section>
      <section>
        <h3 className="slug">Kept on our servers</h3>
        <div>
          <ul>
            <li>Your email and login</li>
            <li>The agreement you accepted when you signed up</li>
            <li>
              Your subscription and billing status, if you have one. Card
              details go to Stripe, not to us.
            </li>
            <li>Feedback you send: ratings, comments and some timing figures about how a take ran</li>
          </ul>
          <p>None of that includes your script, your audio or your video.</p>
        </div>
      </section>
      <p className="ledger-more">
        <Link className="link" to="/faq#your-script">
          Read the full answer in the FAQ
        </Link>
      </p>
    </div>
  );
}
