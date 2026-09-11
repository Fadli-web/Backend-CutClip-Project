import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';

const execFileAsync = promisify(execFile);

/**
 * Mencari binary yt-dlp yang tersedia di sistem
 * Urutan prioritas:
 * 1. config.ytdlpPath (dari .env)
 * 2. `yt-dlp` / `yt-dlp.exe` di PATH
 * 3. `python -m yt_dlp`
 */
export async function getExecutableCommand() {
  if (config.ytdlpPath && fs.existsSync(config.ytdlpPath)) {
    return { cmd: config.ytdlpPath, prefixArgs: [] };
  }

  // Cek apakah yt-dlp ada di sistem PATH
  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? 'where' : 'which';
    await execFileAsync(checkCmd, ['yt-dlp']);
    return { cmd: 'yt-dlp', prefixArgs: [] };
  } catch (e) {
    // Cek python -m yt_dlp
    try {
      await execFileAsync('python', ['-m', 'yt_dlp', '--version']);
      return { cmd: 'python', prefixArgs: ['-m', 'yt_dlp'] };
    } catch (err) {
      // Fallback ke yt-dlp bawaan yt-dlp-exec jika ada
      return { cmd: 'yt-dlp', prefixArgs: [] };
    }
  }
}

/**
 * Mengambil metadata video YouTube (judul, thumbnail, durasi total, id)
 * @param {string} url - Tautan YouTube
 * @returns {Promise<{ id: string, title: string, duration: number, thumbnail: string }>}
 */
export async function getVideoMetadata(url) {
  const { cmd, prefixArgs } = await getExecutableCommand();
  const args = [
    ...prefixArgs,
    '--dump-json',
    '--no-playlist',
    '--skip-download',
  ];

  if (config.proxyUrl) {
    args.push('--proxy', config.proxyUrl);
  }
  if (config.cookiesPath && fs.existsSync(config.cookiesPath)) {
    args.push('--cookies', config.cookiesPath);
  }

  args.push(url);

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Gagal mengambil metadata video (exit ${code}): ${stderr}`));
      }
      try {
        const info = JSON.parse(stdout);
        resolve({
          id: info.id,
          title: info.title,
          duration: info.duration,
          thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[0]?.url) || '',
        });
      } catch (parseErr) {
        reject(new Error(`Gagal mem-parsing JSON metadata video: ${parseErr.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Tidak dapat menjalankan perintah yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Mengunduh segmen video spesifik menggunakan --download-sections
 * Ini sangat cepat karena HANYA mengunduh rentang waktu yang diminta,
 * bukan seluruh video berukuran ratusan MB/GB.
 *
 * @param {Object} options
 * @param {string} options.url - Tautan YouTube
 * @param {number} options.startTime - Waktu mulai (detik)
 * @param {number} options.endTime - Waktu selesai (detik)
 * @param {string} options.outputTemplate - Path pola output berkas
 * @param {function} [options.onProgress] - Callback progress persentase
 * @returns {Promise<string>} Path file video hasil unduhan
 */
export async function downloadVideoSegment({ url, startTime, endTime, outputTemplate, onProgress }) {
  const { cmd, prefixArgs } = await getExecutableCommand();

  // Format parameter segmen yt-dlp: "*start-end"
  const sectionSpec = `*${startTime}-${endTime}`;

  const args = [
    ...prefixArgs,
    '--no-playlist',
    '--download-sections', sectionSpec,
    '--force-keyframes-at-cuts',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4] / bv*+ba/b',
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
    console.log(`🚀 [yt-dlp] Menjalankan: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args);
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      // Parsing progress bar persentase dari output yt-dlp [download]  45.0% of ...
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

      // Cari file yang dihasilkan berdasarkan outputTemplate
      const targetDir = path.dirname(outputTemplate);
      const baseNameWithoutExt = path.basename(outputTemplate, path.extname(outputTemplate));
      
      try {
        const files = fs.readdirSync(targetDir);
        const matched = files.find(f => f.startsWith(baseNameWithoutExt));
        if (matched) {
          resolve(path.join(targetDir, matched));
        } else {
          // Jika outputTemplate adalah file langsung
          if (fs.existsSync(outputTemplate)) {
            resolve(outputTemplate);
          } else {
            reject(new Error(`File hasil unduhan segmen tidak ditemukan di ${targetDir}`));
          }
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
