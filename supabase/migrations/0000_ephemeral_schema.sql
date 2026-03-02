-- Ephemeral Supabase Database Schema
-- Run this via Supabase CLI or SQL Editor in the Supabase Dashboard
-- WARNING: This will drop existing messages and statuses tables. 

DROP TABLE IF EXISTS public.messages;
DROP TABLE IF EXISTS public.statuses;

-- ==========================================
-- 1. MESSAGES TABLE (Ephemeral Metadata)
-- ==========================================
CREATE TABLE public.messages (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    receiver TEXT NOT NULL,
    text TEXT,
    media_type TEXT,
    media_url TEXT,
    media_caption TEXT,
    reply_to_id TEXT,
    status TEXT DEFAULT 'sent',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- RLS Policies
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- The mobile app still uses Anon Key occasionally for direct sends/reads or Realtime, 
-- but Node.js Server handles the bulk using Service-Role key.
CREATE POLICY "Enable read access for authenticated users" ON public.messages FOR SELECT USING (auth.role() = 'authenticated' OR true);
CREATE POLICY "Enable insert access for authenticated users" ON public.messages FOR INSERT WITH CHECK (auth.role() = 'authenticated' OR true);
CREATE POLICY "Enable update access for authenticated users" ON public.messages FOR UPDATE USING (auth.role() = 'authenticated' OR true);
CREATE POLICY "Enable delete access for authenticated users" ON public.messages FOR DELETE USING (auth.role() = 'authenticated' OR true);

-- ==========================================
-- 2. STATUSES TABLE (Ephemeral Metadata)
-- ==========================================
CREATE TABLE public.statuses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_name TEXT,
    user_avatar TEXT,
    media_url TEXT,
    media_type TEXT DEFAULT 'image',
    caption TEXT,
    likes JSONB DEFAULT '[]'::jsonb,
    views JSONB DEFAULT '[]'::jsonb,
    music JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- RLS Policies
ALTER TABLE public.statuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for authenticated users" ON public.statuses FOR SELECT USING (auth.role() = 'authenticated' OR true);
CREATE POLICY "Enable insert access for authenticated users" ON public.statuses FOR INSERT WITH CHECK (auth.role() = 'authenticated' OR true);
CREATE POLICY "Enable update access for authenticated users" ON public.statuses FOR UPDATE USING (auth.role() = 'authenticated' OR true);
CREATE POLICY "Enable delete access for authenticated users" ON public.statuses FOR DELETE USING (auth.role() = 'authenticated' OR true);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.statuses;
