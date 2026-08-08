-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.

-- Stores the parsed result of every script a user has uploaded, so My
-- Account can list past scripts and re-launch Practice from saved steps
-- without calling the parse-script AI endpoint again. pdf_path points at
-- the original PDF in the "scripts" storage bucket so it can be viewed
-- from My Account, independent of the parsed steps.
create table if not exists public.scripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  language_code text not null default 'en',
  language_name text not null default 'English',
  characters jsonb not null default '[]'::jsonb,
  steps jsonb not null,
  pdf_path text,
  created_at timestamptz not null default now()
);

alter table public.scripts enable row level security;

create policy "users can read their own scripts"
  on public.scripts for select
  using (auth.uid() = user_id);

-- Inserted directly by the client (Practice.tsx) right after a successful
-- parse — no server-side write path needed since this isn't metered or
-- security-sensitive like entitlements.
create policy "users can insert their own scripts"
  on public.scripts for insert
  with check (auth.uid() = user_id);

create index if not exists scripts_user_id_created_at_idx
  on public.scripts (user_id, created_at desc);

-- Private bucket holding the original uploaded PDFs, one object per script
-- row at "<user_id>/<script_id>.pdf". Viewed via short-lived signed URLs
-- (createSignedUrl), never served publicly.
insert into storage.buckets (id, name, public)
values ('scripts', 'scripts', false)
on conflict (id) do nothing;

create policy "users can upload their own script pdfs"
  on storage.objects for insert
  with check (
    bucket_id = 'scripts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users can read their own script pdfs"
  on storage.objects for select
  using (
    bucket_id = 'scripts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
