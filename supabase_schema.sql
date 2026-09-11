-- ==============================================================================
-- SKEMA BASIS DATA SUPABASE: YOUTUBE VIDEO CLIPPER (AI-POWERED WITH GEMINI)
-- ==============================================================================

-- 1. Inisialisasi Ekstensi yang Dibutuhkan
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Tabel `projects` (Untuk video panjang yang dianalisis oleh AI Gemini)
CREATE TABLE IF NOT EXISTS public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    youtube_url TEXT NOT NULL,
    youtube_video_id VARCHAR(32) NOT NULL,
    video_title TEXT,
    video_duration INT,
    thumbnail_url TEXT,
    status TEXT NOT NULL DEFAULT 'analyzing' CHECK (status IN ('analyzing', 'ready', 'failed')),
    ai_summary TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Buat / Perbarui Tabel `clips`
CREATE TABLE IF NOT EXISTS public.clips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    youtube_url TEXT NOT NULL,
    youtube_video_id VARCHAR(32) NOT NULL,
    video_title TEXT,
    thumbnail_url TEXT,
    start_time NUMERIC(10, 2) NOT NULL CHECK (start_time >= 0),
    end_time NUMERIC(10, 2) NOT NULL CHECK (end_time > start_time),
    duration NUMERIC(10, 2) GENERATED ALWAYS AS (end_time - start_time) STORED,
    
    -- Atribut Khusus Kurasi AI (Gemini Flash)
    ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
    virality_score INT CHECK (virality_score >= 0 AND virality_score <= 100),
    curation_reason TEXT,
    hook_text TEXT,
    suggested_caption TEXT,

    -- Status Pemrosesan Video (Worker)
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    progress INT NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    storage_path TEXT,
    download_url TEXT,
    file_size_bytes BIGINT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '48 hours'),

    -- Validasi durasi klip antara 3 detik hingga 180 detik (3 menit)
    CONSTRAINT check_duration_range CHECK (
        (end_time - start_time) >= 3 AND (end_time - start_time) <= 180
    )
);

-- 4. Trigger untuk Otomatisasi Kolom `updated_at`
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_projects_updated_at ON public.projects;
CREATE TRIGGER trigger_projects_updated_at
    BEFORE UPDATE ON public.projects
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trigger_clips_updated_at ON public.clips;
CREATE TRIGGER trigger_clips_updated_at
    BEFORE UPDATE ON public.clips
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- 5. Indeks Performa
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON public.projects(user_id);
CREATE INDEX IF NOT EXISTS idx_clips_user_id ON public.clips(user_id);
CREATE INDEX IF NOT EXISTS idx_clips_project_id ON public.clips(project_id);
CREATE INDEX IF NOT EXISTS idx_clips_status ON public.clips(status);
CREATE INDEX IF NOT EXISTS idx_clips_created_at ON public.clips(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_expires_at ON public.clips(expires_at);

-- 6. Konfigurasi Row Level Security (RLS)
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;

-- Policy untuk `projects`
CREATE POLICY "Users can view own projects"
    ON public.projects FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own projects"
    ON public.projects FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects"
    ON public.projects FOR DELETE
    USING (auth.uid() = user_id);

-- Policy untuk `clips`
CREATE POLICY "Users can view own clips"
    ON public.clips FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own clips"
    ON public.clips FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own clips"
    ON public.clips FOR DELETE
    USING (auth.uid() = user_id);

-- 7. Aktifkan Replikasi Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
ALTER PUBLICATION supabase_realtime ADD TABLE public.clips;

-- 8. Setup Storage Bucket `clips`
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('clips', 'clips', true, 104857600, ARRAY['video/mp4'])
ON CONFLICT (id) DO UPDATE 
SET public = true,
    file_size_limit = 104857600,
    allowed_mime_types = ARRAY['video/mp4'];

-- Kebijakan akses Storage
CREATE POLICY "Public Access for clips"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'clips');

CREATE POLICY "Service role can upload clips"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'clips');

-- 9. Fungsi Pembersihan Otomatis Berkas Kedaluwarsa (> 48 Jam)
CREATE OR REPLACE FUNCTION public.get_expired_clips()
RETURNS TABLE (
    clip_id UUID,
    storage_path TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT id, clips.storage_path
    FROM public.clips
    WHERE expires_at <= now() AND status = 'completed' AND clips.storage_path IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
