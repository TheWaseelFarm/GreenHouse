-- ============================================================================
-- Al-Waseel Farm — keep an approved user's temporary password visible to the
-- admin until the user sets their own. Run ONCE in Supabase → SQL Editor.
-- Safe to re-run.
--
-- Security: this stores the TEMPORARY password in plaintext ONLY between
-- approval and the user's first password change (it is cleared then, and the
-- temp password expires 48h after approval regardless). It is readable only by
-- the server-side service key (RLS is on with no public policies). The user's
-- real password is always a bcrypt hash in password_hash.
-- ============================================================================

alter table users add column if not exists temp_password text;
