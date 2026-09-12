import express from 'express';
import { supabaseAdmin } from '../services/supabase.js';
import { uploadUserAvatar } from '../services/storage.js';

const router = express.Router();

/**
 * Middleware untuk mengautentikasi bearer token dari Supabase Auth
 */
async function authenticateUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token otentikasi tidak ditemukan. Harap login terlebih dahulu.' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Sesi kedaluwarsa atau tidak valid. Silakan login kembali.' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Gagal memvalidasi sesi: ' + err.message });
  }
}

/**
 * POST /api/user/avatar
 * Mengunggah foto profil pengguna baru
 */
router.post('/avatar', authenticateUser, async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Data gambar (imageBase64) harus disertakan.' });
    }

    const result = await uploadUserAvatar({
      userId: req.user.id,
      imageBase64,
      mimeType: mimeType || 'image/jpeg',
    });

    res.json({
      success: true,
      message: 'Foto profil berhasil diperbarui',
      avatar_url: result.avatar_url,
    });
  } catch (err) {
    console.error('❌ Error uploading user avatar:', err);
    res.status(500).json({ error: err.message || 'Gagal mengunggah foto profil' });
  }
});

export default router;
