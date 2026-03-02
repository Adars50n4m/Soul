import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, 'server/.env') });
// fallback to try loading from mobile if server doesn't have it
if (!process.env.EXPO_PUBLIC_SUPABASE_URL) {
  dotenv.config({ path: path.resolve(__dirname, 'mobile/.env') });
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://wiyvlwqfubtysxmbxikq.supabase.co';
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseKey) {
  console.error("No Supabase key found in env files");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data, error } = await supabase.from('statuses').select('*');
  if (error) {
    console.error("Error fetching statuses:", error);
  } else {
    console.log("Statuses in DB:", JSON.stringify(data, null, 2));
    
    // Also test the gt query
    const { data: active, error: err2 } = await supabase
      .from('statuses')
      .select('*')
      .gt('expires_at', new Date().toISOString());
      
    console.log("Active statuses:", active?.length);
  }
}

check();
