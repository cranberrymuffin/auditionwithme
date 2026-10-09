-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.
--
-- Per-take rehearsal metrics, saved on the audition's feedback row so a
-- rating can be read next to how the take actually ran (reader latency,
-- how lines advanced). Collected by src/lib/takeMetrics.ts during the take,
-- kept on the local self-tape record until feedback is submitted, then
-- inserted by selfTapeStore.ts submitFeedback alongside rating/comment.
--
-- Numeric only, plus a coarse device class and the camera's frame size: no
-- transcripts, script text, or audio ever land here.
--
-- Every column is nullable: existing rows, takes recorded before this
-- shipped, and metrics not measured yet all insert as null.
-- reader_latency_ms_* run from the client time of the Scribe message (or
-- advance trigger) that completed the actor's line to the 'playing' event of
-- the next reader line, so they exclude Scribe's own transcription lag and
-- undercount the gap the actor actually perceives.
-- lines_silence_advanced is kept apart from lines_semantic_advanced: the two
-- have different false-positive profiles and tuning levers. It stays 0 until
-- silence-based advance ships, and the pregen_* / live_fetches_during_take
-- columns stay null until reader-audio pre-generation ships.
alter table public.self_tape_feedback
  add column if not exists reader_latency_ms_p50 integer,
  add column if not exists reader_latency_ms_max integer,
  add column if not exists lines_auto_detected integer,
  add column if not exists lines_manual_next integer,
  add column if not exists lines_semantic_advanced integer,
  add column if not exists lines_silence_advanced integer,
  add column if not exists pregen_ms integer,
  add column if not exists pregen_failed_lines integer,
  add column if not exists live_fetches_during_take integer,
  add column if not exists device_class text,
  add column if not exists video_width integer,
  add column if not exists video_height integer;
