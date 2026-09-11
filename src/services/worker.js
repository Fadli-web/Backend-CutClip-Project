import path from 'path';
import fs from 'fs';
import { supabaseAdmin } from './supabase.js';
import { downloadVideoSegment, getVideoMetadata } from './ytdlp.js';
import { cutAndEncodeVideo } from './ffmpeg.js';
import { uploadClipToStorage } from './storage.js';
import { config } from '../config/env.js';

let isProcessing = false;

/**
 * Memperbarui status dan progress tugas klip di Supabase DB
 */
async function updateClipStatus(clipId, updates) {
  try {
    const { error } = await supabaseAdmin
      .from('clips')
      .update(updates)
      .eq('id', clipId);

    if (error) {
      console.error(`⚠️ Gagal update status clip ${clipId}:`, error.message);
    }
  } catch (err) {
    console.error(`⚠️ Exception update status:`, err.message);
  }
}

/**
 * Membersihkan file lokal sementara
 */
function cleanLocalFiles(...filePaths) {
  for (const fp of filePaths) {
    if (fp && fs.existsSync(fp)) {
      try {
        fs.unlinkSync(fp);
      } catch (e) {
        console.warn(`Gagal menghapus file temp ${fp}:`, e.message);
      }
    }
  }
}

/**
 * Memproses 1 tugas pemotongan video (Clip Job)
 * @param {string} clipId - UUID klip di tabel `clips`
 */
export async function processClipJob(clipId) {
  console.log(`\n🎬 [Worker] Memulai pemrosesan tugas klip: ${clipId}`);

  // 1. Ambil data klip dari Supabase
  const { data: clip, error } = await supabaseAdmin
    .from('clips')
    .select('*')
    .eq('id', clipId)
    .single();

  if (error || !clip) {
    console.error(`❌ Klip ${clipId} tidak ditemukan di database!`, error?.message);
    return;
  }

  if (clip.status === 'completed') {
    console.log(`ℹ️ Klip ${clipId} sudah berstatus 'completed'. Melewati.`);
    return;
  }

  // Tandai sebagai sedang diproses
  await updateClipStatus(clipId, {
    status: 'processing',
    progress: 10,
    error_message: null,
  });

  const tempDownloadedFile = path.join(config.tempDir, `raw_${clipId}.mp4`);
  const finalOutputFile = path.join(config.tempDir, `final_${clipId}.mp4`);

  try {
    // 2. Lengkapi metadata video jika belum ada
    if (!clip.video_title || !clip.thumbnail_url) {
      try {
        console.log(`🔍 [Worker] Mengambil metadata video YouTube: ${clip.youtube_url}`);
        const meta = await getVideoMetadata(clip.youtube_url);
        await updateClipStatus(clipId, {
          video_title: meta.title || 'YouTube Video Clip',
          thumbnail_url: meta.thumbnail || '',
        });
      } catch (metaErr) {
        console.warn('Gagal mengambil metadata opsional, melanjutkan pemotongan:', metaErr.message);
      }
    }

    // 3. Unduh segmen yang dituju menggunakan yt-dlp
    console.log(`⬇️ [Worker] Mengunduh segmen ${clip.start_time}s s.d ${clip.end_time}s...`);
    await updateClipStatus(clipId, { progress: 25 });

    const downloadedPath = await downloadVideoSegment({
      url: clip.youtube_url,
      startTime: clip.start_time,
      endTime: clip.end_time,
      outputTemplate: tempDownloadedFile,
      onProgress: async (p) => {
        // Rentang download: 25% s.d 55%
        const mappedProgress = Math.round(25 + (p * 0.3));
        await updateClipStatus(clipId, { progress: mappedProgress });
      },
    });

    // 4. Potong presisi & Transcode ke standar web MP4 via FFmpeg
    console.log(`✂️ [Worker] Transcoding FFmpeg ke format MP4 H.264...`);
    await updateClipStatus(clipId, { progress: 60 });

    const clipDuration = clip.end_time - clip.start_time;
    const clipFormat = clip.aspect_ratio || '9:16';
    await cutAndEncodeVideo({
      inputPath: downloadedPath,
      outputPath: finalOutputFile,
      startTime: 0, // Karena segmen sudah dipotong di yt-dlp, kita normalisasi dari 0
      duration: clipDuration,
      format: clipFormat,
      onProgress: async (p) => {
        // Rentang FFmpeg: 60% s.d 80%
        const mappedProgress = Math.round(60 + (p * 0.2));
        await updateClipStatus(clipId, { progress: mappedProgress });
      },
    });

    // 5. Upload ke Supabase Storage
    console.log(`☁️ [Worker] Mengunggah hasil ke Supabase Storage...`);
    await updateClipStatus(clipId, { progress: 85 });

    const { storagePath, publicUrl, fileSizeBytes } = await uploadClipToStorage({
      filePath: finalOutputFile,
      userId: clip.user_id,
      clipId: clip.id,
    });

    // 6. Tandai selesai di database
    console.log(`✅ [Worker] Klip ${clipId} berhasil diproses!`);
    await updateClipStatus(clipId, {
      status: 'completed',
      progress: 100,
      storage_path: storagePath,
      download_url: publicUrl,
      file_size_bytes: fileSizeBytes,
      error_message: null,
    });

  } catch (err) {
    console.error(`💥 [Worker] Gagal memproses klip ${clipId}:`, err.message);
    let friendlyError = err.message || 'Terjadi kesalahan internal saat pemrosesan klip.';
    if (friendlyError.includes("Sign in to confirm you’re not a bot") || friendlyError.includes("Sign in to confirm you're not a bot")) {
      friendlyError = 'YouTube membatasi video ini dengan proteksi bot / login Google. Silakan coba tautan video YouTube publik lainnya.';
    } else if (friendlyError.includes('This video is unavailable') || friendlyError.includes('Private video')) {
      friendlyError = 'Video tidak tersedia atau berstatus privat di YouTube.';
    } else if (friendlyError.includes('SIGKILL') || friendlyError.includes('killed with signal')) {
      friendlyError = 'Alokasi RAM server tidak mencukupi untuk video berdurasi ini.';
    }

    await updateClipStatus(clipId, {
      status: 'failed',
      error_message: friendlyError,
    });
  } finally {
    // 7. Bersihkan file lokal sementara di disk
    cleanLocalFiles(tempDownloadedFile, finalOutputFile);
  }
}

/**
 * Worker polling otomatis: Mengambil tugas dengan status 'queued' secara berkala
 */
export async function pollAndProcessNextJob() {
  if (isProcessing) return;

  try {
    isProcessing = true;
    const { data: jobs, error } = await supabaseAdmin
      .from('clips')
      .select('id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      // Jika kredensial belum diisi atau error koneksi
      return;
    }

    if (jobs && jobs.length > 0) {
      const nextJob = jobs[0];
      await processClipJob(nextJob.id);
    }
  } catch (err) {
    console.error('Error saat polling antrean klip:', err.message);
  } finally {
    isProcessing = false;
  }
}
