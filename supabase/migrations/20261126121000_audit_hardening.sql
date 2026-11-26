-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.
--
-- A set of small fixes from a code audit. Each statement is safe to re-run.

-- 1. The Stripe webhook finds a user's row by stripe_customer_id on every
-- event, with no index behind it, and nothing stopped two rows from sharing
-- a customer (which would make one payment unlock both). Unique when the
-- data allows it; if duplicates already exist the index is created plain,
-- with a warning, so this migration never fails on old data -- clean the
-- duplicates up and re-run to get the unique one.
do $$
begin
  if exists (
    select 1
    from public.entitlements
    where stripe_customer_id is not null
    group by stripe_customer_id
    having count(*) > 1
  ) then
    raise warning 'entitlements has rows sharing a stripe_customer_id; created a non-unique index instead of a unique one';
    create index if not exists entitlements_stripe_customer_id_idx
      on public.entitlements (stripe_customer_id)
      where stripe_customer_id is not null;
  else
    create unique index if not exists entitlements_stripe_customer_id_key
      on public.entitlements (stripe_customer_id)
      where stripe_customer_id is not null;
    drop index if exists public.entitlements_stripe_customer_id_idx;
  end if;
end;
$$;

-- 2. Signup.tsx sends the time of acceptance in auth.signUp()'s
-- options.data, and the trigger stored it as given -- so the client chose
-- its own acceptance time, and a value that wasn't a timestamp made the
-- cast fail and the signup with it. Which agreements were accepted still
-- comes from the metadata (a key that is present and non-empty);
-- the time recorded is now the server's.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.entitlements (
    user_id,
    nda_accepted_at,
    terms_version,
    terms_accepted_at,
    auto_renew_consent_at
  )
  values (
    new.id,
    case when nullif(meta ->> 'nda_accepted_at', '') is not null then now() end,
    meta ->> 'terms_version',
    case when nullif(meta ->> 'terms_accepted_at', '') is not null then now() end,
    case when nullif(meta ->> 'auto_renew_consent_at', '') is not null then now() end
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- 3. Feedback comments are inserted straight from the browser
-- (selfTapeStore.ts) with no length limit. Added NOT VALID so the table
-- isn't scanned under the lock and old rows can't block it -- new rows are
-- checked from here on -- then validated only if every existing row passes.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'self_tape_feedback_comment_length'
      and conrelid = 'public.self_tape_feedback'::regclass
  ) then
    alter table public.self_tape_feedback
      add constraint self_tape_feedback_comment_length
      check (comment is null or char_length(comment) <= 5000) not valid;
  end if;

  if exists (
    select 1 from public.self_tape_feedback where char_length(comment) > 5000
  ) then
    raise warning 'self_tape_feedback has comments over 5000 characters; self_tape_feedback_comment_length left NOT VALID';
  else
    alter table public.self_tape_feedback
      validate constraint self_tape_feedback_comment_length;
  end if;
end;
$$;

-- 4. The admin portal (api/admin.ts) pages through feedback newest first.
create index if not exists self_tape_feedback_submitted_at_idx
  on public.self_tape_feedback (submitted_at desc, id);

-- 5. Functions nothing calls any more. issue_rehearsal_grant counted free
-- sessions; grants are signed in api/_entitlement.ts now. accept_beta_nda
-- was a fallback for recording NDA acceptance after signup that the app
-- never used.
drop function if exists public.issue_rehearsal_grant(uuid);
drop function if exists public.accept_beta_nda();

-- 6. Policies for the "scripts" and "self-tapes" storage buckets, both long
-- deleted (drop_pdf_storage.sql, drop_scripts_and_self_tapes.sql). Deleting
-- a bucket leaves its storage.objects policies behind.
drop policy if exists "users can upload their own script pdfs" on storage.objects;
drop policy if exists "users can read their own script pdfs" on storage.objects;
drop policy if exists "users can upload their own self tapes" on storage.objects;
drop policy if exists "users can read their own self tapes storage" on storage.objects;
drop policy if exists "users can delete their own self tapes storage" on storage.objects;
