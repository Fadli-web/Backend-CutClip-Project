import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Ensure temp download directory exists
const TEMP_DIR = process.env.TEMP_DIR 
  ? path.resolve(process.env.TEMP_DIR) 
  : path.resolve(__dirname, '../../temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: 
    process.env.SUPABASE_SERVICE_ROLE_SECRET_KEY || 
    process.env.SUPABASE_SERVICE_ROLE_KEY || 
    '',
  supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'clips',
  
  // Google AI Studio Gemini Flash Configuration
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',

  // Custom binaries if specified (defaults to system PATH or packages)
  ffmpegPath: process.env.FFMPEG_PATH || '',
  ytdlpPath: process.env.YTDLP_PATH || '',
  
  // Anti-bot YouTube options
  proxyUrl: process.env.YT_PROXY || '',
  cookiesPath: process.env.YT_COOKIES_PATH || '',
  
  // Worker settings
  pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '5000', 10),
  retentionHours: parseInt(process.env.RETENTION_HOURS || '48', 10),
  cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || '3600000', 10), // Every 1 hour
  
  // Temp folder
  tempDir: TEMP_DIR,
};
