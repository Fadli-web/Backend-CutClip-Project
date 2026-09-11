import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config/env.js';

/**
 * Menganalisis transkrip berstempel waktu menggunakan Google Gemini Flash
 * untuk menemukan cuplikan paling viral (highlight clips)
 *
 * @param {Object} options
 * @param {string} options.videoTitle - Judul video YouTube
 * @param {number} options.videoDuration - Total durasi video (detik)
 * @param {string} options.formattedTranscript - Transkrip berstempel waktu
 * @returns {Promise<{ summary: string, recommendations: Array<Object> }>}
 */
export async function analyzeTranscriptWithGemini({ videoTitle, videoDuration, formattedTranscript }) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY belum disetel di file .env! Dapatkan API Key gratis di Google AI Studio (aistudio.google.com).');
  }

  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const modelName = config.geminiModel || 'gemini-3.5-flash';

  const systemInstruction = `
Kamu adalah kurator video pendek viral profesional kelas dunia (ahli dalam YouTube Shorts, TikTok, dan Instagram Reels).
Tugas utamamu adalah menganalisis konten video YouTube (baik dari transkrip berstempel waktu maupun estimasi ritme berdasarkan judul & durasi), lalu menemukan 3 hingga 6 momen terbaik untuk dijadikan video pendek vertikal.

Kriteria Cuplikan Viral:
1. **Hook yang Menusuk**: Dimulai dengan kalimat pembuka yang langsung memicu rasa ingin tahu, pernyataan kontroversial, atau pertanyaan menggelitik.
2. **Klimaks Emosi / Wawasan**: Mengandung puncak kelucuan, punchline jenaka, momen dramatis, aksi menegangkan, atau wawasan daging yang bernilai tinggi.
3. **Alur Klip Alami**: Waktu mulai (start_time) dan waktu selesai (end_time) harus berada dalam batas durasi video total (0 hingga ${videoDuration} detik).
4. **Durasi Optimal**: Setiap klip berdurasi antara 15 hingga 90 detik (harus berada dalam batas minimum 3 detik dan maksimum 180 detik).
5. **Skor Viralitas (1 - 100)**: Berikan penilaian realistis berdasarkan kekuatan hook, retensi penonton, dan potensi dibagikan (shareability).
`;

  let userPrompt = '';
  if (formattedTranscript && formattedTranscript.trim().length > 0) {
    userPrompt = `
Berikut adalah data video YouTube yang perlu kamu kurasi:
- Judul Video: "${videoTitle}"
- Total Durasi: ${videoDuration} detik (~${(videoDuration / 60).toFixed(1)} menit)

Transkrip Berstempel Waktu:
---
${formattedTranscript}
---

Instruksi Tambahan:
- Berikan ringkasan video secara umum (summary).
- Ekstrak 3 sampai 6 rekomendasi klip terbaik dengan titik start_time dan end_time presisi berdasarkan stempel waktu transkrip.
`;
  } else {
    userPrompt = `
Berikut adalah data video YouTube yang perlu kamu kurasi (video ini tidak memiliki takarir teks berstempel waktu bawaan):
- Judul Video: "${videoTitle}"
- Total Durasi: ${videoDuration} detik (~${(videoDuration / 60).toFixed(1)} menit)

Instruksi Khusus (Tanpa Takarir):
- Berikan ringkasan video secara umum (summary) berdasarkan konteks judul dan genre konten tersebut.
- Prediksikan 3 sampai 5 segmen highlight klip terbaik yang terdistribusi secara dinamis sepanjang durasi video (misalnya momen pembuka/intro, aksi seru/klimaks di pertengahan video, dan konklusi/penutup seru).
- Pastikan setiap klip memiliki start_time dan end_time yang realistis (antara 0 hingga ${videoDuration} detik), dengan durasi masing-masing klip berkisar 15 - 60 detik.
`;
  }

  console.log(`🤖 [Gemini] Mengirim data video ke model ${modelName}...`);

  const response = await ai.models.generateContent({
    model: modelName,
    contents: userPrompt,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description: 'Ringkasan singkat bahasan keseluruhan isi video',
          },
          recommendations: {
            type: Type.ARRAY,
            description: 'Daftar rekomendasi klip pendek dengan potensi viral tinggi',
            items: {
              type: Type.OBJECT,
              properties: {
                title: {
                  type: Type.STRING,
                  description: 'Judul klip yang menarik dan click-worthy (5-8 kata)',
                },
                start_time: {
                  type: Type.NUMBER,
                  description: 'Titik detik mulai yang presisi di awal kalimat',
                },
                end_time: {
                  type: Type.NUMBER,
                  description: 'Titik detik selesai yang tuntas menutup kalimat',
                },
                duration: {
                  type: Type.NUMBER,
                  description: 'Durasi klip dalam detik (end_time - start_time)',
                },
                virality_score: {
                  type: Type.INTEGER,
                  description: 'Skor perkiraan viralitas dari 1 hingga 100',
                },
                curation_reason: {
                  type: Type.STRING,
                  description: 'Alasan kurasi: mengapa momen ini menarik atau berbobot',
                },
                hook_text: {
                  type: Type.STRING,
                  description: 'Kalimat pembuka yang diucapkan pembicara pada awal klip',
                },
                suggested_caption: {
                  type: Type.STRING,
                  description: 'Saran caption media sosial lengkap dengan hashtag relevan',
                },
              },
              required: [
                'title',
                'start_time',
                'end_time',
                'duration',
                'virality_score',
                'curation_reason',
                'hook_text',
              ],
            },
          },
        },
        required: ['summary', 'recommendations'],
      },
    },
  });

  const responseText = response.text;
  try {
    const parsedData = JSON.parse(responseText);

    // Validasi dan normalisasi durasi rekomendasi
    if (parsedData.recommendations && Array.isArray(parsedData.recommendations)) {
      parsedData.recommendations = parsedData.recommendations.map(rec => {
        const start = Math.max(0, parseFloat(rec.start_time));
        let end = parseFloat(rec.end_time);
        let duration = end - start;

        // Pastikan tidak melanggar aturan platform (3 - 180 detik)
        if (duration < 3) {
          end = start + 3;
          duration = 3;
        } else if (duration > 180) {
          end = start + 180;
          duration = 180;
        }

        return {
          ...rec,
          start_time: Math.round(start * 10) / 10,
          end_time: Math.round(end * 10) / 10,
          duration: Math.round(duration * 10) / 10,
          virality_score: Math.min(100, Math.max(1, rec.virality_score || 75)),
        };
      });
    }

    return parsedData;
  } catch (err) {
    throw new Error(`Gagal membaca respons terstruktur dari Gemini: ${err.message}. Raw text: ${responseText}`);
  }
}
