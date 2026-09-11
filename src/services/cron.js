import { supabaseAdmin } from './supabase.js';
import { deleteClipFromStorage } from './storage.js';
import { config } from '../config/env.js';

/**
 * Membersihkan klip yang telah melewati batas simpan 48 jam
 */
export async function cleanupExpiredClips() {
  console.log('🧹 [Retention Cron] Memeriksa berkas klip yang kedaluwarsa (> 48 jam)...');

  try {
    const nowIso = new Date().toISOString();
    
    // Cari klip yang masa berlakunya habis
    const { data: expiredClips, error } = await supabaseAdmin
      .from('clips')
      .select('id, storage_path')
      .lte('expires_at', nowIso)
      .not('storage_path', 'is', null);

    if (error) {
      console.warn('⚠️ Gagal mengambil daftar klip kedaluwarsa:', error.message);
      return { cleanedCount: 0 };
    }

    if (!expiredClips || expiredClips.length === 0) {
      console.log('✨ Tidak ada berkas klip yang kedaluwarsa saat ini.');
      return { cleanedCount: 0 };
    }

    console.log(`Menemukan ${expiredClips.length} klip kedaluwarsa untuk dibersihkan...`);

    let cleanedCount = 0;
    for (const clip of expiredClips) {
      // 1. Hapus dari Supabase Storage
      if (clip.storage_path) {
        await deleteClipFromStorage(clip.storage_path);
      }

      // 2. Kosongkan link & storage_path pada record DB (atau tandai kedaluwarsa)
      await supabaseAdmin
        .from('clips')
        .update({
          storage_path: null,
          download_url: null,
          error_message: 'Berkas video telah dihapus karena melewati batas retensi 48 jam.',
        })
        .eq('id', clip.id);

      cleanedCount++;
    }

    console.log(`✅ Sukses membersihkan ${cleanedCount} berkas klip kedaluwarsa.`);
    return { cleanedCount };
  } catch (err) {
    console.error('❌ Error saat menjalankan pembersihan retensi klip:', err.message);
    return { error: err.message };
  }
}
