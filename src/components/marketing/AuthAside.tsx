// The right-hand column of the sign-in pages on wide screens: a page of
// sides, marked up the way an actor would, in place of a photograph.
// Decorative, so hidden from assistive tech; the scene is invented.
export default function AuthAside() {
  return (
    <aside className="auth-aside span-5 at-8" aria-hidden="true">
      <div className="sides">
        <div className="sides-head">
          <span>diner_sides.pdf</span>
          <span>Page 1 of 3</span>
        </div>
        <div className="sides-body">
          <p className="sides-slug">Int. Diner - Night</p>
          <p className="sides-action">
            Dev has been waiting a while. Mara comes in from the rain.
          </p>
          <div className="sides-line">
            <span className="sides-num">01</span>
            <div>
              <p className="sides-cue">Dev</p>
              <p className="sides-dialogue">
                <span>You’re late.</span>
              </p>
            </div>
          </div>
          <div className="sides-line is-yours">
            <span className="sides-num">02</span>
            <div>
              <p className="sides-cue">Mara</p>
              <p className="sides-dialogue">
                <span>I know. The train sat outside the station for forty minutes.</span>
              </p>
              <p className="sides-note">don’t apologise yet</p>
            </div>
          </div>
          <div className="sides-line">
            <span className="sides-num">03</span>
            <div>
              <p className="sides-cue">Dev</p>
              <p className="sides-dialogue">
                <span>You could have called.</span>
              </p>
            </div>
          </div>
          <div className="sides-line is-yours">
            <span className="sides-num">04</span>
            <div>
              <p className="sides-cue">Mara</p>
              <p className="sides-dialogue">
                <span>My phone was dead. I’m sorry.</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
