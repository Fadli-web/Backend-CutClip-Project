import fs from 'fs';
import path from 'path';
import { supabaseAdmin } from './supabase.js';
import { config } from '../config/env.js';

/**
 * Mengunggah file video klip hasil olahan ke Supabase Storage
 * @param {Object} options
 * @param {string} options.filePath - Path file lokal .mp4
 * @param {string} options.userId - ID pemilik klip
 * @param {string} options.clipId - UUID klip
 * @returns {Promise<{ storagePath: string, publicUrl: string, fileSizeBytes: number }>}
 */
export async function uploadClipToStorage({ filePath, userId, clipId }) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileStats = fs.statSync(filePath);
  const storagePath = `${userId}/${clipId}.mp4`;

  console.log(`📤 [Storage] Mengunggah ${storagePath} (${(fileStats.size / (1024 * 1024)).toFixed(2)} MB)...`);

  const { data, error } = await supabaseAdmin.storage
    .from(config.supabaseStorageBucket)
    .upload(storagePath, fileBuffer, {
      contentType: 'video/mp4',
      upsert: true,
    });

  if (error) {
    throw new Error(`Supabase Storage upload gagal: ${error.message}`);
  }

  // Dapatkan Public URL
  const { data: publicUrlData } = supabaseAdmin.storage
    .from(config.supabaseStorageBucket)
    .getPublicUrl(storagePath);

  return {
    storagePath,
    publicUrl: publicUrlData.publicUrl,
    fileSizeBytes: fileStats.size,
  };
}

/**
 * Menghapus file dari Supabase Storage
 * @param {string} storagePath
 */
export async function deleteClipFromStorage(storagePath) {
  if (!storagePath) return;
  const { error } = await supabaseAdmin.storage
    .from(config.supabaseStorageBucket)
    .remove([storagePath]);

  if (error) {
    console.error(`⚠️ Gagal menghapus storage path ${storagePath}:`, error.message);
  } else {
    console.log(`🗑️ Berhasil menghapus file kedaluwarsa dari storage: ${storagePath}`);
  }
}
