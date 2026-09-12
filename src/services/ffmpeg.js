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
/**
 * Memecah teks panjang menjadi beberapa baris agar pas pada layar vertikal 9:16
 */
function wrapCaptionText(text, maxCharsPerLine = 26) {
  if (!text) return '';
  const clean = text.replace(/\r?\n/g, ' ').trim();
  const words = clean.split(/\s+/);
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.join('\n');
}

/**
 * Format detik ke format stempel waktu SRT (HH:MM:SS,mmm)
 */
function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Menghasilkan isi file SRT dari segmen transkrip berstempel waktu
 * Dinormalisasi ke detik awal klip
 */
export function generateSrtContent(segments, clipStartTime = 0, clipDuration = 999999) {
  let srt = '';
  let index = 1;

  for (const seg of segments) {
    const rawStart = seg.start !== undefined ? seg.start : 0;
    const rawEnd = seg.end !== undefined ? seg.end : rawStart + 2;

    const normStart = Math.max(0, rawStart - clipStartTime);
    const normEnd = Math.min(clipDuration, rawEnd - clipStartTime);

    if (normEnd > normStart + 0.1 && seg.text && seg.text.trim()) {
      const wrapped = wrapCaptionText(seg.text, 24);
      srt += `${index}\n`;
      srt += `${formatSrtTime(normStart)} --> ${formatSrtTime(normEnd)}\n`;
      srt += `${wrapped}\n\n`;
      index++;
    }
  }

  return srt;
}

/**
 * Memotong dan mengode ulang video ke MP4 standar web (H.264 + AAC + FastStart)
 * Mendukung format vertikal 9:16 (TikTok, Reels, Shorts) dengan background blur estetik
 * serta opsi subtitle dinamis yang sinkron dengan ucapan pembicara (gaya TikTok/Shorts).
 *
 * @param {Object} options
 * @param {string} options.inputPath - Path video input
 * @param {string} options.outputPath - Path video output (.mp4)
 * @param {number} options.startTime - Waktu awal cuplikan (detik)
 * @param {number} options.duration - Durasi cuplikan (detik)
 * @param {string} [options.format='9:16'] - Format rasio ('9:16' vertikal atau 'original')
 * @param {string} [options.captionText=''] - Teks caption fallback jika tidak ada segmen
 * @param {string} [options.captionPosition='bottom'] - Posisi caption ('bottom' atau 'center')
 * @param {Array<Object>} [options.segments=[]] - Array segmen transkrip berstempel waktu ({start, end, text})
 * @param {number} [options.clipStartTime=0] - Titik detik asli awal klip untuk normalisasi waktu subtitle
 * @param {function} [options.onProgress] - Callback progress persentase (0-100)
 * @returns {Promise<{ outputPath: string, duration: number, sizeBytes: number }>}
 */
export function cutAndEncodeVideo({
  inputPath,
  outputPath,
  startTime,
  duration,
  format = '9:16',
  captionText = '',
  captionPosition = 'bottom',
  segments = [],
  clipStartTime = 0,
  onProgress,
}) {
  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath);
    let tempSrtFile = null;

    // Fast seek sebelum input (-ss) untuk akurasi dan kecepatan
    if (startTime !== undefined && startTime !== null && startTime > 0) {
      command = command.setStartTime(startTime);
    }

    if (duration) {
      command = command.setDuration(duration);
    }

    const outputOptions = [
      '-preset veryfast',
      '-crf 26',
      '-threads 2',           // Mencegah lonjakan RAM di peladen cloud
      '-movflags +faststart', // Web streaming friendly
      '-pix_fmt yuv420p',    // Kompatibilitas luas di semua browser/mobile
    ];

    // Buat file subtitle SRT dinamis jika tersedia segmen kata/kalimat
    if (segments && Array.isArray(segments) && segments.length > 0) {
      try {
        const srtContent = generateSrtContent(segments, clipStartTime, duration || 999999);
        if (srtContent.trim().length > 0) {
          tempSrtFile = path.join(
            config.tempDir,
            `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.srt`
          );
          fs.writeFileSync(tempSrtFile, srtContent, 'utf8');
          console.log(`📝 [FFmpeg] Mengaktifkan subtitle dinamis sinkron pembicara (${segments.length} baris takarir)`);
        }
      } catch (srtErr) {
        console.warn('⚠️ Gagal membuat file SRT subtitle dinamis, beralih ke caption teks:', srtErr.message);
      }
    }

    // Format vertikal 9:16 hemat RAM & super cepat (optimal untuk Railway 512MB)
    if (format === '9:16') {
      const filters = [
        // Background: downscale ke 180x320, blur ringan, lalu upscale ke 720x1280 (menghemat RAM hingga 90%)
        '[0:v]scale=180:320:force_original_aspect_ratio=increase,crop=180:320,boxblur=4:2,scale=720:1280:flags=fast_bilinear[bg]',
        // Foreground: video asli di tengah dengan lebar 720
        '[0:v]scale=720:-2:flags=fast_bilinear[fg]',
      ];

      if (tempSrtFile) {
        // Path dinormalisasi untuk FFmpeg subtitles filter
        const escapedSubPath = tempSrtFile
          .replace(/\\/g, '/')
          .replace(/:/g, '\\:');

        const yMargin = captionPosition === 'center' ? '460' : '150';

        // Subtitle dinamis: teks berganti tepat saat pembicara mengucapkan kalimatnya
        // Font DejaVu Sans tebal, warna kuning cerah (&H0000FFFF), outline hitam tebal 3px
        const subFilter = `subtitles='${escapedSubPath}':force_style='FontName=DejaVu Sans,FontSize=22,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=${yMargin}'`;

        filters.push(
          '[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]',
          `[v_base]${subFilter}[v]`
        );
      } else if (captionText && captionText.trim()) {
        const wrapped = wrapCaptionText(captionText);
        const escaped = wrapped
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'")
          .replace(/:/g, '\\:')
          .replace(/%/g, '\\%');

        const yPos = captionPosition === 'center' ? '(h-text_h)/2' : 'h-text_h-220';

        filters.push(
          '[bg][fg]overlay=(W-w)/2:(H-h)/2[v_base]',
          `[v_base]drawtext=text='${escaped}':fontcolor=yellow:fontsize=32:line_spacing=8:borderw=3:bordercolor=black:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-text_w)/2:y=${yPos}[v]`
        );
      } else {
        filters.push('[bg][fg]overlay=(W-w)/2:(H-h)/2[v]');
      }

      command.complexFilter(filters);
      // Petakan kedua stream: video vertikal [v] DAN audio asli 0:a?
      outputOptions.unshift('-map [v]', '-map 0:a?');
    }

    const cleanupTempSrt = () => {
      if (tempSrtFile && fs.existsSync(tempSrtFile)) {
        try { fs.unlinkSync(tempSrtFile); } catch (_) {}
      }
    };

    command
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions(outputOptions)
      .on('progress', (progress) => {
        if (onProgress && progress.percent) {
          onProgress(Math.min(99, Math.max(1, Math.round(progress.percent))));
        }
      })
      .on('end', () => {
        cleanupTempSrt();
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
        cleanupTempSrt();
        console.error('❌ FFmpeg Error:', err.message);
        if (stderr) console.error('FFmpeg stderr:', stderr);
        reject(new Error(`FFmpeg encoding gagal: ${err.message}`));
      })
      .save(outputPath);
  });
}
