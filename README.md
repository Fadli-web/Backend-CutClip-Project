# YouTube Video Clipper - Backend Worker

Worker backend terpisah menggunakan **Express.js**, **yt-dlp**, dan **FFmpeg** untuk mengeksekusi pemotongan video YouTube berdurasi spesifik secara asinkron dan mengunggah hasilnya ke **Supabase Storage**.

---

## 🚀 Fitur Utama

1. **Kurasi Cerdas AI (Google Gemini Flash)**: Menganalisis data takarir/subtitle berstempel waktu dari video panjang (siniar, gelar wicara, siaran gim) untuk mendeteksi pembuka kalimat (hook), puncak kelucuan, atau wawasan berbobot, lengkap dengan perkiraan skor viralitas (1-100) dan alasan kurasi.
2. **Unduhan Parsial Cepat**: Menggunakan argumen `--download-sections "*start-end"` pada `yt-dlp` sehingga peladen hanya mengunduh potongan video yang diminta, bukan berkas video utuh.
3. **Standar Web Encoding**: Transcoding otomatis melalui `FFmpeg` ke format MP4 (`H.264`, audio `AAC`, `-movflags +faststart`) agar dapat diputar langsung di semua browser dan ponsel.
4. **Pembaruan Status Realtime**: Terintegrasi langsung dengan Supabase PostgreSQL dan Supabase Storage.
5. **Pembersihan Otomatis (Retensi 48 Jam)**: Memiliki background scheduler untuk menghapus berkas video lama guna menghemat penyimpanan.
6. **Dukungan Anti-Bot**: Mendukung parameter proxy dan cookies YouTube untuk menghindari pemblokiran IP.
7. **Siap Deploy Railway**: Disertai `Dockerfile` multi-stage untuk kemudahan deployment ke Railway atau penyedia PaaS kontainer lainnya.

---

## 📁 Struktur Direktori

```
Backend/
├── src/
│   ├── config/
│   │   └── env.js          # Konfigurasi & validasi variabel lingkungan
│   ├── routes/
│   │   └── jobs.js         # Endpoint REST API (health, metadata, trigger job)
│   ├── services/
│   │   ├── cron.js         # Scheduler pembersihan berkas kedaluwarsa 48 jam
│   │   ├── ffmpeg.js       # Pemotong & transcoder video MP4
│   │   ├── storage.js      # Uploader & deleter Supabase Storage
│   │   ├── supabase.js     # Supabase Admin Client (Service Role Key)
│   │   ├── worker.js       # Pemroses antrean klip asinkron
│   │   └── ytdlp.js        # Downloader segmen video YouTube
│   └── index.js            # Inisialisasi peladen Express & background worker
├── Dockerfile              # Konfigurasi kontainer Railway (FFmpeg + yt-dlp)
├── supabase_schema.sql     # Skrip DDL database Supabase & RLS
├── .env.example            # Contoh konfigurasi environment variable
└── package.json
```

---

## 🛠️ Langkah Menjalankan Secara Lokal

### 1. Eksekusi Skema Database Supabase
1. Buka [Supabase Dashboard](https://supabase.com/dashboard).
2. Masuk ke **SQL Editor** pada proyek Anda.
3. Buka dan salin isi file `supabase_schema.sql`, lalu klik **Run**.
4. Skema akan membuat:
   - Tabel `public.clips` dengan proteksi Row Level Security (RLS) dan validasi durasi (3 - 180 detik).
   - Replikasi Realtime pada tabel `clips`.
   - Bucket Storage `clips`.

### 2. Konfigurasi Variabel Lingkungan
Salin `.env.example` menjadi `.env`:
```bash
cp .env.example .env
```
Isi variabel berikut:
```env
PORT=4000
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJh... (Ambil dari Supabase Project Settings -> API -> service_role key)
SUPABASE_STORAGE_BUCKET=clips
```

### 3. Jalankan Peladen
```bash
# Menjalankan worker
npm start

# Atau mode pengembangan (otomatis restart saat ada perubahan file)
npm run dev
```

---

## 🚂 Deployment ke Railway

1. Hubungkan repositori Git Anda ke [Railway](https://railway.app/).
2. Pilih direktori kerja `Backend/`.
3. Railway akan secara otomatis mendeteksi `Dockerfile` yang telah menyertakan:
   - Node.js 22 LTS
   - FFmpeg
   - Rilis biner terbaru `yt-dlp`
4. Di dasbor Railway, buka tab **Variables** dan masukkan:
   - `PORT`: `4000`
   - `SUPABASE_URL`: `<URL Supabase Anda>`
   - `SUPABASE_SERVICE_ROLE_KEY`: `<Service Role Key Supabase Anda>`
   - `SUPABASE_STORAGE_BUCKET`: `clips`
5. Deploy! Railway akan memberikan public domain (contoh: `https://your-clipper-worker.up.railway.app`).

---

## 🛡️ Penanganan Masalah Pemblokiran Bot YouTube

Jika YouTube menolak koneksi dari IP server Railway (`Sign in to confirm you’re not a bot`):
1. **Menggunakan Cookies**:
   - Ekspor cookies YouTube dari browser Anda menggunakan ekstensi seperti *Get cookies.txt LOCALLY*.
   - Simpan berkas sebagai `cookies.txt`.
   - Set variabel lingkungan `YT_COOKIES_PATH=/app/cookies.txt`.
2. **Menggunakan Proxy**:
   - Dapatkan HTTP proxy residential atau datacenter.
   - Set variabel lingkungan `YT_PROXY=http://user:pass@proxy-ip:port`.

---

## 📡 Dokumentasi Endpoint API

| Metode | Endpoint | Deskripsi |
|---|---|---|
| `GET` | `/api/health` | Healthcheck status server |
| `POST` | `/api/ai/analyze` | Menganalisis takarir video panjang via Google Gemini Flash untuk menghasilkan daftar klip viral (`{ "url": "...", "userId": "..." }`) |
| `POST` | `/api/ai/queue-clips` | Mendaftarkan rekomendasi klip AI yang dipilih ke antrean pemotongan Supabase |
| `POST` | `/api/jobs/metadata` | Mengambil judul, thumbnail, dan durasi video dari URL YouTube (`{ "url": "..." }`) |
| `POST` | `/api/jobs/process/:clipId` | Memicu eksekusi pemotongan klip tertentu secara instan |
| `GET` | `/api/jobs/status/:clipId` | Mendapatkan status pemrosesan dan persentase progress klip |
| `POST` | `/api/jobs/clean-expired` | Memicu penghapusan berkas klip yang berusia > 48 jam secara manual |
