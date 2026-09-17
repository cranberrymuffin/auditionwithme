# Audition With Me

Audition With Me is a browser-based rehearsal tool for actors. It turns PDF scripts and audition sides into interactive scenes, reads the other characters aloud, and keeps the actor’s lines visible and easy to follow.

The product is designed for actors who need to rehearse without arranging a reader for every session. It supports typed and scanned PDFs, identifies characters and dialogue, and preserves common audition-side markings when they affect the scene.

## Product capabilities

- Parses full scripts and audition sides from PDF files
- Supports text-based, scanned, and bilingual material
- Identifies characters, dialogue, scene directions, and marked sections
- Lets the actor choose their role and assign voices to the remaining characters
- Reads scene-partner lines aloud while tracking progress through the script
- Applies delivery direction so spoken lines better match the scene
- Saves scripts, casting choices, and rehearsal state for later use
- Avoids reparsing scripts that have already been processed
- Records a self-tape of the actor's take during rehearsal and stores it to the account
- Requires a rating and comment on each self-tape before the actor can start another rehearsal (beta)
- Requires NDA acceptance at signup before any script material can be uploaded

## Architecture

The application is split into three main parts.

### Web application

The interface is built with React, TypeScript, and Vite. It contains the public product pages, account views, PDF preview, role selection, voice casting, and rehearsal experience. The site is installable as a progressive web app and uses responsive artwork and layouts across desktop, tablet, and phone viewports.

### Script processing

PDF.js handles document loading and local text-layout extraction. When a PDF does not contain a usable text layer, page images are sent through the scanned-document path. Server-side parsing converts the source material into structured dialogue, characters, directions, and language metadata.

Anthropic models are used where document interpretation or scene-level judgment is required, including script parsing, casting assistance, and delivery direction.

### Rehearsal audio

ElevenLabs provides the available voices and generates scene-partner speech. Voice assignments and delivery tags are stored with the script so repeat rehearsals can reuse prior casting and direction instead of rebuilding them each time.

### Accounts and storage

Supabase provides authentication, script records, PDF storage, and self-tape storage. Serverless API routes coordinate external services and keep private credentials out of the browser.
