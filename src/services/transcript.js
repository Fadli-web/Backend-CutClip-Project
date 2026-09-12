import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { YoutubeTranscript } from 'youtube-transcript';
import { config } from '../config/env.js';
import { getExecutableCommand } from './ytdlp.js';

/**
 * Ekstrak 11 karakter ID video YouTube dari berbagai format tautan
 */
export function extractYouTubeVideoId(url) {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : null;
}

/**
 * Mengubah string format waktu WebVTT (HH:MM:SS.mmm atau MM:SS.mmm) menjadi angka detik
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
 * Membersihkan dan mem-parsing isi file WebVTT
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
      const cleanLine = line.replace(/<[^>]+>/g, '').trim();
      if (cleanLine && !currentTextLines.includes(cleanLine)) {
        currentTextLines.push(cleanLine);
      }
    }
  }

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

  // Gabungkan segmen kata yang berdekatan
  const merged = [];
  for (const seg of segments) {
    if (merged.length === 0) {
      merged.push(seg);
      continue;
    }
    const last = merged[merged.length - 1];
    if (seg.start - last.end < 1.2 && last.end - last.start < 8) {
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
 * Mengubah array segmen menjadi transkrip terformat rapi untuk input Gemini
 */
function formatSegments(segments) {
  return segments
    .map((s) => {
      const startMin = Math.floor(s.start / 60);
      const startSec = Math.floor(s.start % 60).toString().padStart(2, '0');
      const endMin = Math.floor(s.end / 60);
      const endSec = Math.floor(s.end % 60).toString().padStart(2, '0');
      return `[${startMin}:${startSec} - ${endMin}:${endSec} | (${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s)] ${s.text}`;
    })
    .join('\n');
}

/**
 * Mengambil transkrip / subtitle video YouTube:
 * 1. Prioritas 1: Ekstraksi langsung via YouTube TimedText API (bebas bot challenge & super cepat)
 * 2. Prioritas 2 (Fallback): Menggunakan yt-dlp dengan mobile client args
 */
export async function extractVideoTranscript(url) {
  const videoId = extractYouTubeVideoId(url) || url;

  // METODE 1: Ekstraksi langsung via timedtext / youtube-transcript (Bebas Bot Challenge)
  try {
    console.log(`📝 [Transcript] Mencoba ekstraksi langsung via TimedText API untuk ID: ${videoId}...`);
    const rawItems = await YoutubeTranscript.fetchTranscript(videoId);

    if (rawItems && rawItems.length > 0) {
      console.log(`✨ [Transcript] Berhasil mendapatkan ${rawItems.length} segmen takarir secara instan!`);
      const segments = rawItems.map((item) => {
        const start = (item.offset || 0) / 1000;
        const duration = (item.duration || 3000) / 1000;
        return {
          start: Math.round(start * 10) / 10,
          end: Math.round((start + duration) * 10) / 10,
          text: item.text.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
        };
      });

      return {
        segments,
        formattedTranscript: formatSegments(segments),
      };
    }
  } catch (timedTextErr) {
    console.warn('⚠️ Ekstraksi TimedText API gagal/tidak tersedia, beralih ke yt-dlp:', timedTextErr.message);
  }

  // METODE 2: Fallback ke yt-dlp dengan mobile player client spoofing
  try {
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
      '--js-runtimes', 'node',
      // Gunakan player client yang bebas bot challenge & PO token
      '--extractor-args', 'youtube:player_client=android_vr,web_embedded,tv,ios',
      '-o', outputTemplate,
    ];

    if (config.proxyUrl) {
      args.push('--proxy', config.proxyUrl);
    }
    if (config.cookiesPath && fs.existsSync(config.cookiesPath)) {
      args.push('--cookies', config.cookiesPath);
    }

    args.push(url);

    console.log(`📝 [Transcript Fallback] Mengambil subtitle video via yt-dlp: ${url}`);

    const result = await new Promise((resolve, reject) => {
      const proc = spawn(cmd, args);
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        try {
          const files = fs.readdirSync(config.tempDir);
          const vttFiles = files.filter((f) => f.startsWith(filePrefix) && f.endsWith('.vtt'));

          if (vttFiles.length === 0) {
            return resolve(null);
          }

          const targetVtt = vttFiles.find((f) => f.includes('.id.')) || vttFiles[0];
          const vttFilePath = path.join(config.tempDir, targetVtt);
          const vttContent = fs.readFileSync(vttFilePath, 'utf-8');

          vttFiles.forEach((f) => {
            try { fs.unlinkSync(path.join(config.tempDir, f)); } catch (e) {}
          });

          const segments = parseVttContent(vttContent);
          if (segments.length === 0) {
            return resolve(null);
          }

          resolve({
            segments,
            formattedTranscript: formatSegments(segments),
            hasTranscript: true,
          });
        } catch (err) {
          resolve(null);
        }
      });

      proc.on('error', () => {
        resolve(null);
      });
    });

    if (result) return result;
  } catch (ytSubErr) {
    console.warn('yt-dlp subtitle extraction error:', ytSubErr.message);
  }

  // Jika tidak ada takarir/subtitle (misal musik, video pendek, atau dimatikan oleh kreator)
  console.log('ℹ️ [Transcript] Video tidak memiliki takarir. Gemini akan memproses kurasi berdasarkan metadata video.');
  return {
    segments: [],
    formattedTranscript: null,
    hasTranscript: false,
  };
}
