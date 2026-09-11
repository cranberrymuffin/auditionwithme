-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.

-- Drops the original-PDF storage introduced with public.scripts. The parsed
-- steps are the only thing My Account and the replay path ever need, so the
-- uploaded PDFs (and the bucket holding them) are dead weight.
--
-- IMPORTANT: run `node scripts/purge-script-pdfs.mjs --confirm` BEFORE this
-- migration. Supabase rejects direct SQL deletes on storage.objects /
-- storage.buckets ("Direct deletion from storage tables is not allowed. Use
-- the Storage API instead."), so emptying and deleting the "scripts" bucket
-- has to go through the Storage API, not this file. That script also drops
-- the bucket itself, which takes its storage.objects RLS policies with it.

alter table public.scripts drop column pdf_path;
