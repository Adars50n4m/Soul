-- ============================================================
-- Migration: Repair orphan profiles by username and expose
-- canonical auth user id lookup for request flows
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_user_id_by_username(p_username TEXT)
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT au.id::text
  FROM auth.users au
  INNER JOIN public.profiles p
    ON LOWER(p.username) = LOWER(p_username)
  WHERE LOWER(COALESCE(au.raw_user_meta_data->>'username', '')) = LOWER(p_username)
     OR au.id::text = p.id::text
  LIMIT 1;
$$;

DO $$
DECLARE
  orphan_profile RECORD;
BEGIN
  FOR orphan_profile IN
    SELECT
      p.id::text AS old_profile_id,
      au.id::text AS new_profile_id
    FROM public.profiles p
    INNER JOIN auth.users au
      ON LOWER(COALESCE(p.username, '')) = LOWER(COALESCE(au.raw_user_meta_data->>'username', ''))
    WHERE NOT EXISTS (
      SELECT 1
      FROM auth.users existing_auth
      WHERE existing_auth.id::text = p.id::text
    )
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.profiles canonical_profile
      WHERE canonical_profile.id::text = orphan_profile.new_profile_id
    ) THEN
      DELETE FROM public.profiles
      WHERE id::text = orphan_profile.old_profile_id;
    ELSE
      UPDATE public.profiles
      SET id = orphan_profile.new_profile_id
      WHERE id::text = orphan_profile.old_profile_id;
    END IF;
  END LOOP;
END $$;
