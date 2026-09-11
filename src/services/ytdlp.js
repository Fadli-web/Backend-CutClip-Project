import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';

const execFileAsync = promisify(execFile);

/**
 * Ekstrak ID video YouTube dari berbagai format tautan
 */
export function extractVideoIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]*).*/);
  return match && match[2].length === 11 ? match[2] : null;
}

/**
 * Mencari binary yt-dlp yang tersedia di sistem
 */
export async function getExecutableCommand() {
  if (config.ytdlpPath && fs.existsSync(config.ytdlpPath)) {
    return { cmd: config.ytdlpPath, prefixArgs: [] };
  }

  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? 'where' : 'which';
    await execFileAsync(checkCmd, ['yt-dlp']);
    return { cmd: 'yt-dlp', prefixArgs: [] };
  } catch (e) {
    try {
      await execFileAsync('python', ['-m', 'yt_dlp', '--version']);
      return { cmd: 'python', prefixArgs: ['-m', 'yt_dlp'] };
    } catch (err) {
      return { cmd: 'yt-dlp', prefixArgs: [] };
    }
  }
}

/**
 * Mengambil metadata video YouTube (judul, thumbnail, durasi total, id)
 * Menggunakan YouTube Official oEmbed API sebagai benteng utama (100% bebas blokir bot)
 * dipadukan dengan yt-dlp mobile client.
 *
 * @param {string} url - Tautan YouTube
 * @returns {Promise<{ id: string, title: string, duration: number, thumbnail: string }>}
 */
export async function getVideoMetadata(url) {
  const videoId = extractVideoIdFromUrl(url) || 'unknown';
  let oembedData = null;

  // 1. Ambil data dari YouTube Official oEmbed API (Instan, bebas blokir datacenter)
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(oembedUrl);
    if (res.ok) {
      oembedData = await res.json();
    }
  } catch (oembedErr) {
    console.warn('oEmbed API fetch failed, fallback to yt-dlp:', oembedErr.message);
  }

  // 2. Coba ambil durasi detail menggunakan yt-dlp mobile client spoofing
  try {
    const { cmd, prefixArgs } = await getExecutableCommand();
    const args = [
      ...prefixArgs,
      '--dump-json',
      '--no-playlist',
      '--skip-download',
      '--js-runtimes', 'node',
      // Gunakan mobile client agar tidak ditantang "Sign in to confirm you're not a bot"
      '--extractor-args', 'youtube:player_client=ios,android,mweb',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    ];

    if (config.proxyUrl) {
      args.push('--proxy', config.proxyUrl);
    }
    if (config.cookiesPath && fs.existsSync(config.cookiesPath)) {
      args.push('--cookies', config.cookiesPath);
    }

    args.push(url);

    const ytDlpResult = await new Promise((resolve, reject) => {
      const proc = spawn(cmd, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(stderr || `yt-dlp exit code ${code}`));
        }
        try {
          const info = JSON.parse(stdout);
          resolve({
            id: info.id || videoId,
            title: info.title,
            duration: info.duration || 300,
            thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[0]?.url) || '',
          });
        } catch (parseErr) {
          reject(parseErr);
        }
      });

      proc.on('error', reject);
    });

    return ytDlpResult;
  } catch (ytErr) {
    console.warn('⚠️ yt-dlp metadata fetch warning:', ytErr.message);

    // Jika yt-dlp diblokir bot challenge, kita TETAP selamat berkat data oEmbed!
    if (oembedData) {
      console.log('✅ Menggunakan metadata dari YouTube oEmbed API.');
      return {
        id: videoId,
        title: oembedData.title || 'YouTube Video Clip',
        duration: 300, // Default aman 5 menit
        thumbnail: oembedData.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    }

    // Jika keduanya gagal, return fallback dasar
    return {
      id: videoId,
      title: `Video (${videoId})`,
      duration: 300,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  }
}

/**
 * Mengunduh segmen video spesifik menggunakan --download-sections
 * Dilengkapi mobile client spoofing untuk melewati bot detection Railway
 */
export async function downloadVideoSegment({ url, startTime, endTime, outputTemplate, onProgress }) {
  const { cmd, prefixArgs } = await getExecutableCommand();
  const sectionSpec = `*${startTime}-${endTime}`;

  const args = [
    ...prefixArgs,
    '--no-playlist',
    '--download-sections', sectionSpec,
    '--force-keyframes-at-cuts',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4] / bv*+ba/b',
    '--js-runtimes', 'node',
    // Mobile client bypass untuk cloud server
    '--extractor-args', 'youtube:player_client=ios,android,mweb',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    '-o', outputTemplate,
  ];

  if (config.proxyUrl) {
    args.push('--proxy', config.proxyUrl);
  }
  if (config.cookiesPath && fs.existsSync(config.cookiesPath)) {
    args.push('--cookies', config.cookiesPath);
  }

  args.push(url);

  return new Promise((resolve, reject) => {
    console.log(`🚀 [yt-dlp] Menjalankan unduhan segmen: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args);
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const match = text.match(/\[download\]\s+([\d\.]+)%/);
      if (match && match[1] && onProgress) {
        const percent = parseFloat(match[1]);
        onProgress(Math.min(99, Math.round(percent)));
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp pengunduhan segmen gagal (exit ${code}): ${stderr}`));
      }

      const targetDir = path.dirname(outputTemplate);
      const baseNameWithoutExt = path.basename(outputTemplate, path.extname(outputTemplate));

      try {
        const files = fs.readdirSync(targetDir);
        const matched = files.find((f) => f.startsWith(baseNameWithoutExt));
        if (matched) {
          resolve(path.join(targetDir, matched));
        } else if (fs.existsSync(outputTemplate)) {
          resolve(outputTemplate);
        } else {
          reject(new Error(`File hasil unduhan segmen tidak ditemukan di ${targetDir}`));
        }
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Error saat meluncurkan proses yt-dlp: ${err.message}`));
    });
  });
}
