import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';
import { getExecutableCommand } from './ytdlp.js';

/**
 * Mengubah string format waktu WebVTT (HH:MM:SS.mmm atau MM:SS.mmm) menjadi angka detik
 * Contoh: "01:23.450" -> 83.45, "00:02:15.500" -> 135.5
 */
function parseVttTimeToSeconds(timeStr) {
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  } else if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1]);
    return minutes * 60 + seconds;
  }
  return 0;
}

/**
 * Membersihkan dan mem-parsing isi file WebVTT menjadi array segmen takarir bersih
 */
export function parseVttContent(vttContent) {
  const lines = vttContent.replace(/\r\n/g, '\n').split('\n');
  const segments = [];
  let currentStart = null;
  let currentEnd = null;
  let currentTextLines = [];

  const timeRegex = /((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}\.\d{3})/;

  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      // Simpan segmen sebelumnya jika ada
      if (currentStart !== null && currentTextLines.length > 0) {
        const text = currentTextLines.join(' ').replace(/<[^>]+>/g, '').trim();
        if (text) {
          segments.push({
            start: currentStart,
            end: currentEnd,
            text,
          });
        }
        currentTextLines = [];
      }
      currentStart = parseVttTimeToSeconds(match[1]);
      currentEnd = parseVttTimeToSeconds(match[2]);
    } else if (currentStart !== null && line.trim() && !line.startsWith('NOTE') && !line.startsWith('WEBVTT')) {
      // Hilangkan tag waktu inline seperti <00:01:23.456>
      const cleanLine = line.replace(/<[^>]+>/g, '').trim();
      if (cleanLine && !currentTextLines.includes(cleanLine)) {
        currentTextLines.push(cleanLine);
      }
    }
  }

  // Simpan segmen terakhir
  if (currentStart !== null && currentTextLines.length > 0) {
    const text = currentTextLines.join(' ').replace(/<[^>]+>/g, '').trim();
    if (text) {
      segments.push({
        start: currentStart,
        end: currentEnd,
        text,
      });
    }
  }

  // Gabungkan segmen beruntun yang berjarak sangat dekat dan hilangkan duplikasi kata
  const merged = [];
  for (const seg of segments) {
    if (merged.length === 0) {
      merged.push(seg);
      continue;
    }
    const last = merged[merged.length - 1];
    // Jika jeda kurang dari 1.2 detik dan teks baru tidak identik dengan teks sebelumnya
    if (seg.start - last.end < 1.2 && last.end - last.start < 8) {
      // Hindari duplikasi teks kata auto-generated YouTube
      if (!last.text.includes(seg.text)) {
        last.text += ' ' + seg.text;
        last.end = seg.end;
      }
    } else {
      merged.push(seg);
    }
  }

  return merged;
}

/**
 * Mengunduh dan mengekstrak transkrip / subtitle dari video YouTube menggunakan yt-dlp
 * @param {string} url - Tautan YouTube
 * @returns {Promise<{ segments: Array<{ start: number, end: number, text: string }>, formattedTranscript: string }>}
 */
export async function extractVideoTranscript(url) {
  const { cmd, prefixArgs } = await getExecutableCommand();
  const filePrefix = `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const outputTemplate = path.join(config.tempDir, `${filePrefix}.%(ext)s`);

  const args = [
    ...prefixArgs,
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    '--sub-lang', 'id,en,en-orig,en-US',
    '--sub-format', 'vtt',
    '-o', outputTemplate,
  ];

  if (config.proxyUrl) {
    args.push('--proxy', config.proxyUrl);
  }
  if (config.cookiesPath && fs.existsSync(config.cookiesPath)) {
    args.push('--cookies', config.cookiesPath);
  }

  args.push(url);

  console.log(`📝 [Transcript] Mengambil subtitle video dari: ${url}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      try {
        // Cari file vtt yang dihasilkan di tempDir
        const files = fs.readdirSync(config.tempDir);
        const vttFiles = files.filter(f => f.startsWith(filePrefix) && f.endsWith('.vtt'));

        if (vttFiles.length === 0) {
          return reject(new Error('Video ini tidak memiliki takarir/subtitle (manual maupun auto-generated) yang dapat dianalisis oleh AI.'));
        }

        // Utamakan bahasa Indonesia jika ada, jika tidak gunakan file pertama yang ditemukan
        const targetVtt = vttFiles.find(f => f.includes('.id.')) || vttFiles[0];
        const vttFilePath = path.join(config.tempDir, targetVtt);
        const vttContent = fs.readFileSync(vttFilePath, 'utf-8');

        // Bersihkan seluruh file vtt sementara
        vttFiles.forEach(f => {
          try { fs.unlinkSync(path.join(config.tempDir, f)); } catch (e) {}
        });

        const segments = parseVttContent(vttContent);

        if (segments.length === 0) {
          return reject(new Error('Takarir video kosong atau tidak dapat di-parse.'));
        }

        // Format string transkrip yang ramah untuk input model Gemini
        const formattedTranscript = segments
          .map(s => {
            const startMin = Math.floor(s.start / 60);
            const startSec = Math.floor(s.start % 60).toString().padStart(2, '0');
            const endMin = Math.floor(s.end / 60);
            const endSec = Math.floor(s.end % 60).toString().padStart(2, '0');
            return `[${startMin}:${startSec} - ${endMin}:${endSec} | (${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s)] ${s.text}`;
          })
          .join('\n');

        resolve({
          segments,
          formattedTranscript,
        });
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Gagal mengeksekusi ekstraksi subtitle: ${err.message}`));
    });
  });
}
