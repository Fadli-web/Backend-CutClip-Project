import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import jobsRouter from './routes/jobs.js';
import userRouter from './routes/user.js';
import { pollAndProcessNextJob } from './services/worker.js';
import { cleanupExpiredClips } from './services/cron.js';
import { updateYtDlpIfPossible } from './services/ytdlp.js';

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Routes
app.use('/api', jobsRouter);
app.use('/api/user', userRouter);

// Root greeting
app.get('/', (req, res) => {
  res.json({
    name: 'YouTube Video Clipper Backend Worker',
    status: 'online',
    docs: '/api/health',
  });
});

// Start HTTP Server
const server = app.listen(config.port, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 YouTube Clipper Worker aktif di port: ${config.port}`);
  console.log(`🌐 Endpoint Health: http://localhost:${config.port}/api/health`);
  console.log(`==================================================\n`);

  // Periksa & update binary yt-dlp ke versi terbaru secara asinkron
  updateYtDlpIfPossible();
});

// Start Background Polling Worker (memproses klip antrean otomatis)
let pollingTimer = null;
if (config.supabaseUrl && config.supabaseServiceRoleKey) {
  console.log(`🔄 [Worker] Polling antrean otomatis aktif (interval: ${config.pollingIntervalMs}ms)...`);
  pollingTimer = setInterval(pollAndProcessNextJob, config.pollingIntervalMs);
} else {
  console.warn(`⚠️ [Worker] Polling antrean dinonaktifkan karena SUPABASE_URL belum disetel di .env.`);
}

// Start Background Retention Cleanup (setiap interval, default 1 jam)
let cleanupTimer = null;
if (config.supabaseUrl && config.supabaseServiceRoleKey) {
  console.log(`⏳ [Cron] Pembersihan retensi 48 jam terjadwal (interval: ${config.cleanupIntervalMs / 60000} menit)...`);
  cleanupTimer = setInterval(cleanupExpiredClips, config.cleanupIntervalMs);
}

// Graceful Shutdown
function shutdown() {
  console.log('\n🛑 Mematikan server & worker secara aman...');
  if (pollingTimer) clearInterval(pollingTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  server.close(() => {
    console.log('✅ Server telah ditutup.');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
