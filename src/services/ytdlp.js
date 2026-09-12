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
 * Memeriksa dan menyediakan berkas cookies YouTube jika dikonfigurasi
 */
function getEffectiveCookiesPath() {
  if (config.cookiesPath && fs.existsSync(config.cookiesPath)) {
    return config.cookiesPath;
  }
  const cookiesEnv = process.env.YT_COOKIES_CONTENT || process.env.YOUTUBE_COOKIES;
  if (cookiesEnv && cookiesEnv.trim().length > 0) {
    const tempCookies = path.join(config.tempDir, 'youtube_cookies.txt');
    try {
      if (!fs.existsSync(tempCookies)) {
        fs.writeFileSync(tempCookies, cookiesEnv.trim(), 'utf8');
      }
      return tempCookies;
    } catch (e) {
      console.warn('⚠️ Gagal menulis temp cookies:', e.message);
    }
  }
  return null;
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
      // Gunakan player client yang bebas dari kewajiban GVS PO Token & anti-bot challenge
      '--extractor-args', 'youtube:player_client=android_vr,web_embedded,tv,ios',
    ];

    if (config.proxyUrl) {
      args.push('--proxy', config.proxyUrl);
    }
    const cookiesFile = getEffectiveCookiesPath();
    if (cookiesFile) {
      args.push('--cookies', cookiesFile);
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
 * Helper internal untuk mengeksekusi proses unduhan yt-dlp
 */
function runYtDlpDownload(cmd, args, outputTemplate, onProgress, label = 'unduhan segmen') {
  return new Promise((resolve, reject) => {
    console.log(`🚀 [yt-dlp] Menjalankan ${label}: ${cmd} ${args.join(' ')}`);
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
        return reject(new Error(`yt-dlp ${label} gagal (exit ${code}): ${stderr}`));
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
          reject(new Error(`File hasil ${label} tidak ditemukan di ${targetDir}`));
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

/**
 * Mengunduh segmen video spesifik.
 * Prioritas 1: Fast stream cut via --download-sections
 * Prioritas 2 (Fallback): Unduh video via native yt-dlp downloader jika CDN YouTube menolak FFmpeg (403 Forbidden).
 */
export async function downloadVideoSegment({ url, startTime, endTime, outputTemplate, onProgress }) {
  const { cmd, prefixArgs } = await getExecutableCommand();
  const sectionSpec = `*${startTime}-${endTime}`;

  const baseArgs = [
    ...prefixArgs,
    '--no-playlist',
    '--js-runtimes', 'node',
    // Gunakan client yang tidak mewajibkan GVS PO Token & kebal bot challenge di cloud
    '--extractor-args', 'youtube:player_client=android_vr,web_embedded,tv,ios',
  ];

  if (config.ffmpegPath) {
    baseArgs.push('--ffmpeg-location', config.ffmpegPath);
  }
  if (config.proxyUrl) {
    baseArgs.push('--proxy', config.proxyUrl);
  }
  const cookiesFile = getEffectiveCookiesPath();
  if (cookiesFile) {
    baseArgs.push('--cookies', cookiesFile);
  }

  // 1. Coba metode cepat: potong langsung segmen via --download-sections
  const segmentArgs = [
    ...baseArgs,
    '--download-sections', sectionSpec,
    '--force-keyframes-at-cuts',
    '-f', 'bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    url,
  ];

  try {
    const downloadedPath = await runYtDlpDownload(cmd, segmentArgs, outputTemplate, onProgress, 'unduhan segmen langsung');
    return { filePath: downloadedPath, isPreCut: true };
  } catch (segmentErr) {
    console.warn(`⚠️ [yt-dlp] Unduhan segmen langsung gagal (${segmentErr.message}).`);
    console.log(`🔄 [yt-dlp] Mengaktifkan Fallback: Mengunduh video menggunakan native downloader yt-dlp...`);

    // 2. Fallback: Unduh video utuh (dibatasi 720p agar cepat & hemat bandwidth cloud)
    // Pemotongan presisi detik akan ditangani dengan 100% andal oleh FFmpeg lokal
    const fallbackTemplate = path.join(
      path.dirname(outputTemplate),
      `full_${path.basename(outputTemplate)}`
    );

    const fallbackArgs = [
      ...baseArgs,
      '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
      '--merge-output-format', 'mp4',
      '-o', fallbackTemplate,
      url,
    ];

    const fallbackPath = await runYtDlpDownload(cmd, fallbackArgs, fallbackTemplate, onProgress, 'fallback unduhan penuh');
    return { filePath: fallbackPath, isPreCut: false };
  }
}

/**
 * Memeriksa dan memperbarui binary yt-dlp ke rilis terbaru jika didukung
 */
export async function updateYtDlpIfPossible() {
  try {
    const { cmd, prefixArgs } = await getExecutableCommand();
    console.log('🔄 [yt-dlp] Memeriksa pembaruan yt-dlp...');
    const { stdout, stderr } = await execFileAsync(cmd, [...prefixArgs, '-U']);
    console.log(`✅ [yt-dlp] Status update: ${stdout.trim() || stderr.trim() || 'Versi terkini'}`);
  } catch (err) {
    console.log(`ℹ️ [yt-dlp] Update otomatis dilewati: ${err.message}`);
  }
}
