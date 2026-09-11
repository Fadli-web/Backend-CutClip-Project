import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
  console.warn(
    '⚠️ [Supabase] SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum diatur di .env! Fitur sinkronisasi basis data dan penyimpanan tidak akan berfungsi sampai variabel ini disetel.'
  );
}

// Gunakan Service Role Key untuk operasi backend & worker (mengabaikan RLS)
export const supabaseAdmin = createClient(
  config.supabaseUrl || 'https://placeholder-project.supabase.co',
  config.supabaseServiceRoleKey || 'placeholder-service-key',
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
