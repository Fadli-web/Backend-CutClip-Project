import express from 'express';
import { getVideoMetadata } from '../services/ytdlp.js';
import { extractVideoTranscript } from '../services/transcript.js';
import { analyzeTranscriptWithGemini } from '../services/gemini.js';
import { processClipJob } from '../services/worker.js';
import { cleanupExpiredClips } from '../services/cron.js';
import { supabaseAdmin } from '../services/supabase.js';

const router = express.Router();

// 1. Healthcheck
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'youtube-clipper-ai-worker',
  });
});

// 2. Ekstrak Metadata YouTube Manual
router.post('/jobs/metadata', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Parameter "url" YouTube wajib disertakan.' });
  }

  try {
    const metadata = await getVideoMetadata(url);
    res.json({ success: true, metadata });
  } catch (err) {
    console.error('Gagal mengambil metadata YouTube:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. AI Studio Gemini Flash: Analisis Video Panjang & Temukan Klip Viral
router.post('/ai/analyze', async (req, res) => {
  const { url, userId } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Parameter "url" YouTube wajib disertakan.' });
  }

  try {
    // A. Ambil metadata video dasar
    console.log(`🎬 [AI Analyze] Memulai analisis video: ${url}`);
    const metadata = await getVideoMetadata(url);

    // B. Simpan status proyek baru ke Supabase jika userId ada
    let projectId = null;
    if (userId) {
      const { data: projectRecord, error: projErr } = await supabaseAdmin
        .from('projects')
        .insert({
          user_id: userId,
          youtube_url: url,
          youtube_video_id: metadata.id || 'unknown',
          video_title: metadata.title || 'Untitled Video',
          video_duration: metadata.duration || 0,
          thumbnail_url: metadata.thumbnail || '',
          status: 'analyzing',
        })
        .select('id')
        .single();

      if (!projErr && projectRecord) {
        projectId = projectRecord.id;
      }
    }

    // C. Ekstrak transkrip berstempel waktu
    const transcriptData = await extractVideoTranscript(url);

    // D. Kirim ke Gemini Flash untuk kurasi cerdas
    const analysis = await analyzeTranscriptWithGemini({
      videoTitle: metadata.title,
      videoDuration: metadata.duration,
      formattedTranscript: transcriptData.formattedTranscript,
    });

    // E. Perbarui status proyek di basis data
    if (projectId) {
      await supabaseAdmin
        .from('projects')
        .update({
          status: 'ready',
          ai_summary: analysis.summary,
        })
        .eq('id', projectId);
    }

    res.json({
      success: true,
      projectId,
      metadata,
      summary: analysis.summary,
      recommendations: analysis.recommendations,
    });

  } catch (err) {
    console.error('❌ [AI Analyze] Gagal menganalisis video:', err.message);
    res.status(500).json({
      success: false,
      error: err.message || 'Gagal menganalisis video dengan Gemini.',
    });
  }
});

// 4. Mendaftarkan Rekomendasi AI Menjadi Antrean Klip Pemotongan
router.post('/ai/queue-clips', async (req, res) => {
  const { projectId, userId, clips } = req.body;

  if (!userId || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'Parameter userId dan array clips wajib disertakan.' });
  }

  try {
    // Siapkan baris insert
    const insertPayload = clips.map((c) => ({
      project_id: projectId || null,
      user_id: userId,
      youtube_url: c.youtube_url,
      youtube_video_id: c.youtube_video_id,
      video_title: c.title || 'AI Clip Highlight',
      thumbnail_url: c.thumbnail_url || null,
      start_time: c.start_time,
      end_time: c.end_time,
      ai_generated: true,
      virality_score: c.virality_score || 80,
      curation_reason: c.curation_reason || null,
      hook_text: c.hook_text || null,
      suggested_caption: c.suggested_caption || null,
      status: 'queued',
      progress: 0,
    }));

    const { data: insertedClips, error } = await supabaseAdmin
      .from('clips')
      .insert(insertPayload)
      .select('*');

    if (error) {
      throw new Error(`Gagal menyimpan antrean klip: ${error.message}`);
    }

    // Picu pemrosesan asinkron untuk klip pertama
    if (insertedClips && insertedClips.length > 0) {
      processClipJob(insertedClips[0].id).catch(err => {
        console.error('Trigger process clip gagal:', err.message);
      });
    }

    res.json({
      success: true,
      message: `Berhasil mendaftarkan ${insertedClips.length} klip ke antrean pemotongan.`,
      clips: insertedClips,
    });

  } catch (err) {
    console.error('Gagal memasukkan klip ke antrean:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 5. Trigger Segera Pemrosesan Klip Tunggal
router.post('/jobs/process/:clipId', async (req, res) => {
  const { clipId } = req.params;
  if (!clipId) {
    return res.status(400).json({ error: 'Parameter clipId wajib disertakan.' });
  }

  processClipJob(clipId).catch((err) => {
    console.error(`Unhandled error saat memproses klip ${clipId}:`, err);
  });

  res.json({
    success: true,
    message: `Tugas pemrosesan klip ${clipId} telah dimulai di latar belakang.`,
    clipId,
  });
});

// 6. Cek Status Klip
router.get('/jobs/status/:clipId', async (req, res) => {
  const { clipId } = req.params;

  try {
    const { data: clip, error } = await supabaseAdmin
      .from('clips')
      .select('*')
      .eq('id', clipId)
      .single();

    if (error || !clip) {
      return res.status(404).json({ error: 'Klip tidak ditemukan' });
    }

    res.json({ success: true, clip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Trigger Pembersihan Klip Kedaluwarsa (> 48 jam)
router.post('/jobs/clean-expired', async (req, res) => {
  try {
    const result = await cleanupExpiredClips();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
