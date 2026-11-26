-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.
--
-- The free trial is for a person's first subscription only. Eligibility was
-- read from the Stripe customer's subscription history, but deleting an
-- account (api/account.ts) deletes that customer -- so signing up again
-- with the same email earned a fresh trial every time.
--
-- This table outlives the account: one row per email that has started a
-- trial. It is keyed by the SHA-256 hash of the trimmed, lowercased email
-- (api/_trial.ts), so it holds no addresses, and it deliberately has no
-- foreign key to auth.users -- nothing may cascade it away. The Stripe
-- webhook writes a row when a trialing subscription is created;
-- api/billing.ts reads it before offering a trial.
create table if not exists public.trial_uses (
  email_hash text primary key,
  created_at timestamptz not null default now(),
  constraint trial_uses_email_hash_format check (email_hash ~ '^[0-9a-f]{64}$')
);

alter table public.trial_uses enable row level security;

-- Only the service-role API client uses this table: no policies, and no
-- direct table privileges for browser clients either.
revoke all on table public.trial_uses from anon, authenticated;

-- Accounts that have already had a subscription have had their trial.
-- sha256() over the UTF-8 bytes matches what api/_trial.ts computes.
insert into public.trial_uses (email_hash)
select distinct encode(sha256(convert_to(lower(btrim(u.email)), 'UTF8')), 'hex')
from auth.users u
join public.entitlements e on e.user_id = u.id
where e.stripe_subscription_id is not null
  and u.email is not null
on conflict (email_hash) do nothing;
