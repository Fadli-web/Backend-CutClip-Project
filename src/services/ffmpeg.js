import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { config } from '../config/env.js';
import fs from 'fs';

// Set path FFmpeg: gunakan FFMPEG_PATH jika disetel, jika tidak gunakan bundel @ffmpeg-installer
if (config.ffmpegPath) {
  ffmpeg.setFfmpegPath(config.ffmpegPath);
} else if (ffmpegInstaller && ffmpegInstaller.path) {
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
}

/**
 * Memotong dan mengode ulang video ke MP4 standar web (H.264 + AAC + FastStart)
 * Mendukung format vertikal 9:16 (TikTok, Reels, Shorts) dengan background blur estetik
 * @param {Object} options
 * @param {string} options.inputPath - Path video input
 * @param {string} options.outputPath - Path video output (.mp4)
 * @param {number} options.startTime - Waktu awal cuplikan (detik)
 * @param {number} options.duration - Durasi cuplikan (detik)
 * @param {string} [options.format='9:16'] - Format rasio ('9:16' vertikal atau 'original')
 * @param {function} [options.onProgress] - Callback progress persentase (0-100)
 * @returns {Promise<{ outputPath: string, duration: number, sizeBytes: number }>}
 */
export function cutAndEncodeVideo({ inputPath, outputPath, startTime, duration, format = '9:16', onProgress }) {
  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath);

    // Fast seek sebelum input (-ss) untuk akurasi dan kecepatan
    if (startTime !== undefined && startTime !== null && startTime > 0) {
      command = command.setStartTime(startTime);
    }

    if (duration) {
      command = command.setDuration(duration);
    }

    // Format vertikal 9:16 (1080x1920) dengan blur background estetik untuk TikTok, Reels, & Shorts
    if (format === '9:16') {
      command.complexFilter([
        '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5[bg]',
        '[0:v]scale=1080:-2[fg]',
        '[bg][fg]overlay=(W-w)/2:(H-h)/2[v]',
      ], 'v');
    }

    command
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions([
        '-preset fast',
        '-crf 23',
        '-movflags +faststart', // Web streaming friendly
        '-pix_fmt yuv420p',    // Kompatibilitas luas di semua browser/mobile
      ])
      .on('progress', (progress) => {
        if (onProgress && progress.percent) {
          onProgress(Math.min(99, Math.max(1, Math.round(progress.percent))));
        }
      })
      .on('end', () => {
        try {
          const stats = fs.statSync(outputPath);
          resolve({
            outputPath,
            duration,
            sizeBytes: stats.size,
          });
        } catch (err) {
          resolve({
            outputPath,
            duration,
            sizeBytes: 0,
          });
        }
      })
      .on('error', (err, stdout, stderr) => {
        console.error('❌ FFmpeg Error:', err.message);
        if (stderr) console.error('FFmpeg stderr:', stderr);
        reject(new Error(`FFmpeg encoding gagal: ${err.message}`));
      })
      .save(outputPath);
  });
}
