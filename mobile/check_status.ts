import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://soulsync-supabase-proxy.adarshark.workers.dev';
const supabaseKey = 'sb_publishable_9cVY_6oQHMZnV9CaxmMs9Q_7QlUxqlD';

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data, error } = await supabase.from('statuses').select('*');
  if (error) {
    console.error("Error fetching statuses:", error);
  } else {
    console.log("Statuses in DB:");
    console.dir(data, { depth: null });
    
    // Also test the gt query
    const { data: active, error: err2 } = await supabase
      .from('statuses')
      .select('*')
      .gt('expires_at', new Date().toISOString());
      
    console.log("Active statuses:", active?.length);
  }
}

check();
