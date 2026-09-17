-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.

-- Beta requirement: every new account must affirmatively accept the Beta
-- Tester NDA, and that requirement must hold even if someone skips the
-- app's UI and calls the Supabase APIs directly -- not just when a click
-- happens in the browser. See src/pages/Signup.tsx (capture) and the RLS
-- policies below (enforcement).
alter table public.entitlements
  add column if not exists nda_accepted_at timestamptz;

-- Grandfather in every account that already exists -- this requirement is
-- for new signups going forward, same approach used for feedback_required
-- in 20260915120000_self_tape_feedback.sql.
update public.entitlements set nda_accepted_at = now() where nda_accepted_at is null;

-- Signup.tsx passes nda_accepted_at through auth.signUp()'s options.data
-- when the user clicks "Accept and create account" -- there's no session
-- yet at that point (email confirmation is pending) for a client-side,
-- RLS-gated write to entitlements, but options.data lands in
-- raw_user_meta_data on the auth.users row this trigger fires from, so it
-- can be recorded atomically with account creation. Left null (unaccepted)
-- if that metadata is missing -- e.g. a direct call to the auth API that
-- skips the app's signup form entirely -- and the RLS policies below then
-- block that account from every table until it explicitly accepts via
-- accept_beta_nda().
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.entitlements (user_id, nda_accepted_at)
  values (
    new.id,
    case
      when new.raw_user_meta_data ? 'nda_accepted_at'
        then (new.raw_user_meta_data ->> 'nda_accepted_at')::timestamptz
      else null
    end
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Fallback for recording acceptance from an authenticated session directly
-- (rather than at signup time). Upserts because handle_new_user's trigger
-- and api/_entitlement.ts's lazy upsert both race to create this row, so
-- it's not safe to assume a plain update would find one.
create or replace function public.accept_beta_nda()
returns public.entitlements
language sql
security invoker
set search_path = public
as $$
  insert into public.entitlements (user_id, nda_accepted_at)
  values (auth.uid(), now())
  on conflict (user_id) do update set nda_accepted_at = excluded.nda_accepted_at
  returning *;
$$;

-- Shared by the RLS policies below. security invoker (the default) so it
-- reads entitlements as the calling user -- which "users can read their
-- own entitlement row" already allows for this exact row -- rather than
-- needing its own privilege escalation.
create or replace function public.has_accepted_nda()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.entitlements
    where user_id = auth.uid() and nda_accepted_at is not null
  );
$$;

-- Note: entitlements' own "users can read their own entitlement row"
-- policy is deliberately NOT gated on has_accepted_nda() -- the client
-- needs to be able to read that row to find out acceptance is missing in
-- the first place, and gating it would make that unrecoverable.

drop policy if exists "users can read their own scripts" on public.scripts;
create policy "users can read their own scripts"
  on public.scripts for select
  using (auth.uid() = user_id and public.has_accepted_nda());

drop policy if exists "users can insert their own scripts" on public.scripts;
create policy "users can insert their own scripts"
  on public.scripts for insert
  with check (auth.uid() = user_id and public.has_accepted_nda());

drop policy if exists "users can read their own self tapes" on public.self_tapes;
create policy "users can read their own self tapes"
  on public.self_tapes for select
  using (auth.uid() = user_id and public.has_accepted_nda());

drop policy if exists "users can insert their own self tapes" on public.self_tapes;
create policy "users can insert their own self tapes"
  on public.self_tapes for insert
  with check (auth.uid() = user_id and public.has_accepted_nda());

drop policy if exists "users can delete their own self tapes" on public.self_tapes;
create policy "users can delete their own self tapes"
  on public.self_tapes for delete
  using (auth.uid() = user_id and public.has_accepted_nda());

drop policy if exists "users can update feedback on their own self tapes" on public.self_tapes;
create policy "users can update feedback on their own self tapes"
  on public.self_tapes for update
  using (auth.uid() = user_id and public.has_accepted_nda())
  with check (auth.uid() = user_id and public.has_accepted_nda());

-- Same gate on the storage buckets -- otherwise an unaccepted account
-- could still read/write recordings and PDFs directly through the storage
-- API even with the tables above locked down.
drop policy if exists "users can upload their own script pdfs" on storage.objects;
create policy "users can upload their own script pdfs"
  on storage.objects for insert
  with check (
    bucket_id = 'scripts'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.has_accepted_nda()
  );

drop policy if exists "users can read their own script pdfs" on storage.objects;
create policy "users can read their own script pdfs"
  on storage.objects for select
  using (
    bucket_id = 'scripts'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.has_accepted_nda()
  );

drop policy if exists "users can upload their own self tapes" on storage.objects;
create policy "users can upload their own self tapes"
  on storage.objects for insert
  with check (
    bucket_id = 'self-tapes'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.has_accepted_nda()
  );

drop policy if exists "users can read their own self tapes storage" on storage.objects;
create policy "users can read their own self tapes storage"
  on storage.objects for select
  using (
    bucket_id = 'self-tapes'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.has_accepted_nda()
  );

drop policy if exists "users can delete their own self tapes storage" on storage.objects;
create policy "users can delete their own self tapes storage"
  on storage.objects for delete
  using (
    bucket_id = 'self-tapes'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.has_accepted_nda()
  );
