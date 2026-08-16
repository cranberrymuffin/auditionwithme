-- Independent per-user limits keep high-volume TTS playback from exhausting
-- lower-volume casting and Scribe token allowances.
create table if not exists public.api_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null,
  window_started_at timestamptz not null default now(),
  calls_in_window integer not null default 0,
  primary key (user_id, bucket),
  constraint api_rate_limits_bucket_length check (char_length(bucket) between 1 and 40),
  constraint api_rate_limits_calls_nonnegative check (calls_in_window >= 0)
);

alter table public.api_rate_limits enable row level security;

-- Only the service-role API client uses this table. Authenticated browser
-- clients receive no direct table policy.
revoke all on table public.api_rate_limits from anon, authenticated;

drop function if exists public.check_rate_limit(uuid, int, int);

create or replace function public.check_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_window_seconds int,
  p_max_calls int
)
returns boolean
language plpgsql
as $$
declare
  v_allowed boolean;
begin
  insert into public.api_rate_limits (
    user_id,
    bucket,
    window_started_at,
    calls_in_window
  ) values (
    p_user_id,
    p_bucket,
    now(),
    1
  )
  on conflict (user_id, bucket) do update
  set
    window_started_at = case
      when api_rate_limits.window_started_at < now() - make_interval(secs => p_window_seconds)
      then now()
      else api_rate_limits.window_started_at
    end,
    calls_in_window = case
      when api_rate_limits.window_started_at < now() - make_interval(secs => p_window_seconds)
      then 1
      else api_rate_limits.calls_in_window + 1
    end
  returning (calls_in_window <= p_max_calls) into v_allowed;

  return coalesce(v_allowed, false);
end;
$$;

revoke all on function public.check_rate_limit(uuid, text, int, int) from public;
grant execute on function public.check_rate_limit(uuid, text, int, int) to service_role;
