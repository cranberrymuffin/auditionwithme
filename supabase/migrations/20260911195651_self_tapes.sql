-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.

-- One row per self-tape a user records during a rehearsal. storage_path points
-- at the recording in the "self-tapes" bucket; script_id ties it back to the
-- script it was recorded against so My Account can list takes per script.
create table if not exists public.self_tapes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  script_id uuid not null references public.scripts (id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);

alter table public.self_tapes enable row level security;

create policy "users can read their own self tapes"
  on public.self_tapes for select
  using (auth.uid() = user_id);

-- Inserted directly by the client (SelfTapeRecorder.tsx) right after the
-- upload succeeds, same client-write pattern as public.scripts.
create policy "users can insert their own self tapes"
  on public.self_tapes for insert
  with check (auth.uid() = user_id);

create policy "users can delete their own self tapes"
  on public.self_tapes for delete
  using (auth.uid() = user_id);

create index if not exists self_tapes_user_id_script_id_created_at_idx
  on public.self_tapes (user_id, script_id, created_at desc);

-- Private bucket holding the recordings, one object per self_tapes row at
-- "<user_id>/<self_tape_id>.webm". Played back via short-lived signed URLs
-- (createSignedUrl), never served publicly.
insert into storage.buckets (id, name, public)
values ('self-tapes', 'self-tapes', false)
on conflict (id) do nothing;

create policy "users can upload their own self tapes"
  on storage.objects for insert
  with check (
    bucket_id = 'self-tapes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users can read their own self tapes storage"
  on storage.objects for select
  using (
    bucket_id = 'self-tapes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users can delete their own self tapes storage"
  on storage.objects for delete
  using (
    bucket_id = 'self-tapes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
