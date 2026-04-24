-- ============================================================
-- Migration: Automatic Profile Creation Trigger
-- Ensures every auth.user has a public.profile entry
-- ============================================================

-- 1. Create the function that will handle the insertion
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, username, display_name, name, created_at, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', 'user_' || substr(NEW.id::text, 1, 8)),
    COALESCE(NEW.raw_user_meta_data->>'username', 'User'),
    COALESCE(NEW.raw_user_meta_data->>'username', 'User'),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Create the trigger on auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. Backfill missing profiles for existing users
-- This query finds users in auth.users who don't have a record in public.profiles and adds them.
INSERT INTO public.profiles (id, username, display_name, name, created_at, updated_at)
SELECT 
  id, 
  COALESCE(raw_user_meta_data->>'username', 'user_' || substr(id::text, 1, 8)),
  COALESCE(raw_user_meta_data->>'username', 'User'),
  COALESCE(raw_user_meta_data->>'username', 'User'),
  NOW(),
  NOW()
FROM auth.users
WHERE id NOT IN (SELECT id FROM public.profiles)
ON CONFLICT (id) DO NOTHING;
