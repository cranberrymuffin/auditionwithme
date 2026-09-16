-- Beta requirement: every audition (self-tape) recorded from here on must
-- get a piece of feedback before the user can keep using the app — see
-- src/components/FeedbackGate.tsx. feedback_required defaults to true so
-- new rows are gated automatically; the update below grandfathers in every
-- self-tape that already exists so current users aren't retroactively
-- blocked for takes recorded before this feature shipped.
alter table public.self_tapes
  add column if not exists feedback_required boolean not null default true,
  add column if not exists feedback_rating smallint,
  add column if not exists feedback_comment text,
  add column if not exists feedback_submitted_at timestamptz,
  add constraint self_tapes_feedback_rating_range
    check (feedback_rating is null or (feedback_rating between 1 and 5));

update public.self_tapes set feedback_required = false;

-- Submitting feedback updates the row (client-side, right after the
-- FeedbackGate form succeeds) — the table previously only allowed
-- select/insert/delete.
create policy "users can update feedback on their own self tapes"
  on public.self_tapes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
