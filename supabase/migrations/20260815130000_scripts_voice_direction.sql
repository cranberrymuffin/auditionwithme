-- Persists rehearsal voice direction on saved scripts:
--  - character_voices: the confirmed casting (speaker -> ElevenLabs voice id),
--    so replaying a script keeps the same scene partner instead of re-running
--    auto-casting and possibly recasting voices.
--  - delivery_tags: per-line delivery tags from the AI director pass
--    (api/direct-lines.ts), aligned by index with the steps array, so replays
--    skip that model call.
alter table public.scripts
  add column if not exists character_voices jsonb not null default '{}'::jsonb,
  add column if not exists delivery_tags jsonb;

-- Both columns are written by the client after the initial insert (casting is
-- confirmed and tags arrive asynchronously), which needs an update policy —
-- the table previously only allowed select and insert.
create policy "users can update their own scripts"
  on public.scripts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
