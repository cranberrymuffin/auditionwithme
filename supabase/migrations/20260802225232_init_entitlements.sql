-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL. Idempotent-ish: safe to re-run
-- individual statements, but not wrapped in IF NOT EXISTS everywhere.

create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  subscription_status text not null default 'free',
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  free_sessions_used int not null default 0,
  free_sessions_limit int not null default 3,
  -- Sliding-window rate limit shared across the five non-grant metered
  -- routes (tts, character-voices, canonicalize-characters, scribe-token,
  -- voices). See api/_entitlement.ts requireAuthRateLimited.
  metered_window_started_at timestamptz,
  metered_calls_in_window int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.entitlements enable row level security;

create policy "users can read their own entitlement row"
  on public.entitlements for select
  using (auth.uid() = user_id);

-- No insert/update/delete policies for the anon/authenticated roles: all
-- writes happen server-side via the service-role key (api/_entitlement.ts,
-- api/stripe-webhook.ts), matching Principle 3 ("webhooks/server are the
-- sole writer of subscription state").

-- Seeds a free-tier entitlements row for every new Supabase Auth user.
-- api/_entitlement.ts also lazily upserts a row on first access as a
-- fallback in case this trigger doesn't fire (see plan Risks table).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.entitlements (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Atomic check-and-increment for the free-session counter (api/_entitlement.ts
-- issueRehearsalGrant). Subscribers don't consume the counter. Returns the
-- updated row on success, or zero rows if the caller has no free sessions
-- left and no active subscription (api/_entitlement.ts treats "no rows" as
-- a 402).
create or replace function public.issue_rehearsal_grant(p_user_id uuid)
returns setof public.entitlements
language sql
as $$
  update public.entitlements
  set
    free_sessions_used = case
      when subscription_status = 'active' then free_sessions_used
      else free_sessions_used + 1
    end,
    updated_at = now()
  where user_id = p_user_id
    and (subscription_status = 'active' or free_sessions_used < free_sessions_limit)
  returning *;
$$;

-- Atomic sliding-window rate limit shared by the five non-grant metered
-- routes (api/_entitlement.ts requireAuthRateLimited). Resets the window
-- when expired, then increments and checks the cap in one statement so
-- concurrent requests can't both slip through under the limit.
create or replace function public.check_rate_limit(
  p_user_id uuid,
  p_window_seconds int,
  p_max_calls int
)
returns boolean
language plpgsql
as $$
declare
  v_allowed boolean;
begin
  update public.entitlements
  set
    metered_window_started_at = case
      when metered_window_started_at is null
        or metered_window_started_at < now() - make_interval(secs => p_window_seconds)
      then now()
      else metered_window_started_at
    end,
    metered_calls_in_window = case
      when metered_window_started_at is null
        or metered_window_started_at < now() - make_interval(secs => p_window_seconds)
      then 1
      else metered_calls_in_window + 1
    end
  where user_id = p_user_id
  returning (metered_calls_in_window <= p_max_calls) into v_allowed;

  return coalesce(v_allowed, false);
end;
$$;
