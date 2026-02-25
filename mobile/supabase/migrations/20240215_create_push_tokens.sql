-- Create push_tokens table for storing VoIP (iOS) and FCM (Android) push tokens
-- Optimized for mock auth (hari/shri IDs)
DROP TABLE IF EXISTS push_tokens;

CREATE TABLE push_tokens (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id TEXT NOT NULL, -- Use TEXT to support 'hari'/'shri'
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    token TEXT NOT NULL,
    token_type TEXT NOT NULL CHECK (token_type IN ('voip', 'fcm')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Each user can have one token per platform
    UNIQUE(user_id, platform)
);

-- Index for fast lookups by user_id
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);

-- Enable RLS
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;

-- Allow all since we use mock auth
CREATE POLICY "Public manage push tokens"
    ON push_tokens
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Also ensure the profiles table has these columns as fallback
ALTER TABLE profiles 
    ADD COLUMN IF NOT EXISTS push_token TEXT,
    ADD COLUMN IF NOT EXISTS push_token_type TEXT,
    ADD COLUMN IF NOT EXISTS push_platform TEXT;
