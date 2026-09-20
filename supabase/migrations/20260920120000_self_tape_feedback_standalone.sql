-- Audition feedback (rating + comment from FeedbackGate.tsx) moves back to
-- Supabase so the team can actually read it, while the self-tape recording
-- itself stays local (see "Store scripts and self-tapes locally instead of
-- in Supabase"). The old feedback columns on public.self_tapes can't be
-- reused: that table still requires script_id to reference public.scripts
-- and storage_path to be set, but scripts and self-tapes are now IndexedDB
-- records with no server-side counterpart. tape_id/script_id below are
-- informational local ids, not foreign keys.
create table if not exists public.self_tape_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tape_id uuid not null,
  script_id uuid not null,
  rating smallint not null check (rating between 1 and 5),
  comment text,
  recorded_at timestamptz not null,
  submitted_at timestamptz not null default now()
);

alter table public.self_tape_feedback enable row level security;

-- Inserted directly by the client (selfTapeStore.ts submitFeedback) right
-- after the local FeedbackGate form succeeds.
create policy "users can insert their own audition feedback"
  on public.self_tape_feedback for insert
  with check (auth.uid() = user_id);

create policy "users can read their own audition feedback"
  on public.self_tape_feedback for select
  using (auth.uid() = user_id);

create index if not exists self_tape_feedback_user_id_submitted_at_idx
  on public.self_tape_feedback (user_id, submitted_at desc);
