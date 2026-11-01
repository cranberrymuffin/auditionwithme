-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.

-- Outside beta testing, every account must accept the Terms and Conditions
-- (src/lib/termsText.ts) and consent to auto-renewal before it can
-- subscribe. terms_version records which text was accepted, so a new
-- version can be required again later. api/billing.ts refuses to start a
-- subscription until both are recorded for the current version.
--
-- No grandfathering: beta accounts accepted the beta NDA, not these Terms,
-- so they accept them on the pricing page before their first checkout.
alter table public.entitlements
  add column if not exists terms_version text,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists auto_renew_consent_at timestamptz;

-- Signup.tsx passes either nda_accepted_at (beta) or the three terms fields
-- (after beta) through auth.signUp()'s options.data. They land in
-- raw_user_meta_data on the auth.users row this trigger fires from, so
-- acceptance is recorded atomically with account creation. Anything
-- missing stays null; existing users record the Terms later through
-- api/billing.ts?action=accept-terms (service role -- users have no write
-- policy on entitlements).
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
    (meta ->> 'nda_accepted_at')::timestamptz,
    meta ->> 'terms_version',
    (meta ->> 'terms_accepted_at')::timestamptz,
    (meta ->> 'auto_renew_consent_at')::timestamptz
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
