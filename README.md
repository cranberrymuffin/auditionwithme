# Audition With Me

Audition With Me is a browser-based rehearsal tool for actors. It turns PDF scripts and audition sides into interactive scenes, reads the other characters aloud, and keeps the actor’s lines visible and easy to follow.

The product is designed for actors who need to rehearse without arranging a reader for every session. It supports typed and scanned PDFs, identifies characters and dialogue, and preserves common audition-side markings when they affect the scene. Scripts and self-tapes stay on the actor's device — nothing is uploaded to a server unless the actor chooses to.

## Product capabilities

- Parses full scripts and audition sides from PDF files, including scanned pages and bilingual editions
- Identifies characters, dialogue, scene directions, and marked sections, canonicalizing character names that appear inconsistently across scanned pages
- Lets the actor choose their role and assign voices to the remaining characters
- Reads scene-partner lines aloud while tracking the actor's progress through the script via live speech recognition, with a semantic fallback so a garbled read doesn't stall the scene
- Applies AI-directed performance markup (pacing, emphasis, delivery tags) to spoken lines without altering the underlying words, and adds a brief leading pause before each AI-voiced line so it doesn't talk over the actor
- Highlights the active line and turns it red with a blinking cue dot when it's the actor's turn to speak
- Saves scripts, casting choices, and rehearsal state locally in the browser so sessions can resume without reparsing
- Records a self-tape of the actor's take during rehearsal, stored locally on the device
- Requires a rating and comment on each self-tape before the actor can start another rehearsal (beta); the feedback itself is saved to the account
- Requires NDA acceptance at signup before any script material can be uploaded
