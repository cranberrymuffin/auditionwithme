-- Fingerprints each saved script so re-uploading the same PDF can be
-- detected client-side (src/lib/scriptHash.ts) and served from the stored
-- parse instead of calling the parse-script AI endpoint again.
alter table public.scripts
  add column if not exists content_hash text;

create index if not exists scripts_user_id_content_hash_idx
  on public.scripts (user_id, content_hash);
