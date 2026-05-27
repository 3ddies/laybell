import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://wawpaokvtptfmuygjnns.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indhd3Bhb2t2dHB0Zm11eWdqbm5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MDgyNjMsImV4cCI6MjA5NTQ4NDI2M30.78PkYUy1rnoGUvqKSF85QWqbFQF9Kfy2PV3Fzs0nPZY';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});