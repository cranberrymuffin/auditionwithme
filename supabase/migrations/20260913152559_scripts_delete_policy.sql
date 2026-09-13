-- Run this in the Supabase SQL editor (or via `supabase db push`) for the
-- project referenced by VITE_SUPABASE_URL.

-- public.scripts never had a delete policy, so RLS silently blocked every
-- delete attempt (0 rows affected, no error). Deleting a script cascades to
-- its self_tapes rows via the existing "on delete cascade" foreign key.
create policy "users can delete their own scripts"
  on public.scripts for delete
  using (auth.uid() = user_id);
