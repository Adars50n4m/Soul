-- ============================================================
-- Migration: Retire legacy public.users and repoint FKs to profiles
--
-- Context: Two parallel user tables existed — public.profiles (app-owned,
-- auto-populated from auth.users) and public.users (legacy, ~3 rows, not
-- populated by the app). FKs on connection_requests and blocked_users
-- referenced public.users, so inserting a request for any user whose
-- profile existed but had no legacy row failed with FK violation.
-- This migration repoints those FKs at public.profiles(id) and drops
-- the now-unused public.users table.
-- ============================================================

BEGIN;

-- 1. connection_requests: drop legacy FKs, add new FKs -> public.profiles
ALTER TABLE public.connection_requests
  DROP CONSTRAINT IF EXISTS connection_requests_sender_id_fkey,
  DROP CONSTRAINT IF EXISTS connection_requests_receiver_id_fkey;

ALTER TABLE public.connection_requests
  ADD CONSTRAINT connection_requests_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  ADD CONSTRAINT connection_requests_receiver_id_fkey
    FOREIGN KEY (receiver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 2. blocked_users: drop legacy FKs, add new FKs -> public.profiles
ALTER TABLE public.blocked_users
  DROP CONSTRAINT IF EXISTS blocked_users_blocker_id_fkey,
  DROP CONSTRAINT IF EXISTS blocked_users_blocked_user_id_fkey;

ALTER TABLE public.blocked_users
  ADD CONSTRAINT blocked_users_blocker_id_fkey
    FOREIGN KEY (blocker_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  ADD CONSTRAINT blocked_users_blocked_user_id_fkey
    FOREIGN KEY (blocked_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 3. Drop the vestigial public.users table. Verified: no other FKs,
-- no triggers, no views, no migrations reference it; only callers are
-- updated in the same commit as this migration.
DROP TABLE IF EXISTS public.users CASCADE;

-- 4. Enable REPLICA IDENTITY FULL so filtered realtime subscriptions fire correctly.
ALTER TABLE public.connection_requests REPLICA IDENTITY FULL;
ALTER TABLE public.connections REPLICA IDENTITY FULL;

COMMIT;
