-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.
--
-- public.scripts and public.self_tapes are dead weight now that scripts and
-- self-tape recordings both live in IndexedDB (see scriptStore.ts,
-- selfTapeStore.ts) — nothing in the app reads or writes either table
-- anymore. Audition feedback itself already moved to the standalone
-- self_tape_feedback table (see the migration just before this one); the
-- feedback_rating/feedback_comment columns dropped here predate that move
-- and were not carried over.
--
-- IMPORTANT: run `node scripts/purge-self-tapes-storage.mjs --confirm`
-- BEFORE this migration. Supabase rejects direct SQL deletes on
-- storage.objects/storage.buckets ("Direct deletion from storage tables is
-- not allowed. Use the Storage API instead."), so emptying and deleting the
-- "self-tapes" bucket has to go through the Storage API, not this file.
-- (The "scripts" storage bucket was already purged in an earlier migration —
-- see drop_pdf_storage.sql / purge-script-pdfs.mjs.)

-- self_tapes.script_id references public.scripts, so it has to go first.
drop table if exists public.self_tapes;
drop table if exists public.scripts;
