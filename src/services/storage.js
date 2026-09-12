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

/**
 * Mengunggah foto profil pengguna ke Supabase Storage dan memperbarui user_metadata
 * @param {Object} options
 * @param {string} options.userId - ID User Supabase
 * @param {string} options.imageBase64 - String base64 gambar
 * @param {string} options.mimeType - Tipe mime (image/png, image/jpeg, dll)
 * @returns {Promise<{ avatar_url: string }>}
 */
export async function uploadUserAvatar({ userId, imageBase64, mimeType = 'image/jpeg' }) {
  if (!imageBase64) {
    throw new Error('Data gambar base64 tidak boleh kosong');
  }

  // Bersihkan data URL prefix jika ada (contoh: data:image/png;base64,...)
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const fileBuffer = Buffer.from(base64Data, 'base64');

  // Tentukan ekstensi file berdasarkan mimeType
  let ext = 'jpg';
  if (mimeType.includes('png')) ext = 'png';
  else if (mimeType.includes('webp')) ext = 'webp';
  else if (mimeType.includes('gif')) ext = 'gif';

  const bucketName = 'avatars';

  // Pastikan bucket avatars ada
  try {
    const { data: buckets } = await supabaseAdmin.storage.listBuckets();
    if (!buckets?.some((b) => b.name === bucketName)) {
      console.log(`📦 [Storage] Membuat bucket baru: ${bucketName}...`);
      await supabaseAdmin.storage.createBucket(bucketName, {
        public: true,
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'],
      });
    }
  } catch (err) {
    console.warn(`⚠️ [Storage] Catatan bucket:`, err.message);
  }

  const storagePath = `${userId}/avatar_${Date.now()}.${ext}`;
  console.log(`📤 [Storage] Mengunggah avatar ke ${bucketName}/${storagePath}...`);

  let uploadTargetBucket = bucketName;
  let uploadResult = await supabaseAdmin.storage
    .from(uploadTargetBucket)
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: true,
    });

  // Jika bucket avatars gagal, fallback ke default storage bucket
  if (uploadResult.error) {
    console.warn(`⚠️ Gagal upload ke ${bucketName}, mencoba ke ${config.supabaseStorageBucket}:`, uploadResult.error.message);
    uploadTargetBucket = config.supabaseStorageBucket;
    uploadResult = await supabaseAdmin.storage
      .from(uploadTargetBucket)
      .upload(`avatars/${storagePath}`, fileBuffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadResult.error) {
      throw new Error(`Gagal mengunggah foto profil: ${uploadResult.error.message}`);
    }
  }

  // Dapatkan URL publik avatar
  const { data: publicUrlData } = supabaseAdmin.storage
    .from(uploadTargetBucket)
    .getPublicUrl(uploadTargetBucket === bucketName ? storagePath : `avatars/${storagePath}`);

  const publicUrl = publicUrlData.publicUrl;

  // Perbarui user_metadata di Supabase Auth Admin
  try {
    const { data: existingUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const currentMetadata = existingUser?.user?.user_metadata || {};

    await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...currentMetadata,
        avatar_url: publicUrl,
      },
    });
  } catch (metaErr) {
    console.warn('⚠️ Gagal memperbarui user_metadata via admin:', metaErr.message);
  }

  return { avatar_url: publicUrl };
}

