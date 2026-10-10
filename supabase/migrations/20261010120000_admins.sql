-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.
--
-- Accounts that can open the admin portal (src/pages/Admin.tsx), which lists
-- every user and their audition feedback. Designate an admin by inserting
-- their auth user id here, from the SQL editor:
--
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'someone@example.com';
--
-- or with `npm run set-admin -- <email>` (scripts/set-admin.mjs).
--
-- The portal's data comes from api/admin.ts, which reads auth.users and
-- self_tape_feedback with the service-role key and checks this table on
-- every request -- so no RLS policy below grants an admin anything extra.
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- Lets the client find out whether to show the "Admin" link (useIsAdmin.ts).
-- Display-only: api/admin.ts is the real check.
create policy "users can read their own admin row"
  on public.admins for select
  using (auth.uid() = user_id);

-- No insert/update/delete policies: only the SQL editor or the service-role
-- key can grant or revoke admin access, never a signed-in user.
