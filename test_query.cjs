const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://xuipxbyvsawhuldopvjn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9cVY_6oQHMZnV9CaxmMs9Q_7QlUxqlD';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function test() {
  const { data, error } = await supabase.rpc('get_schema');
  console.log("RPC Error:", error);
  
  // Alternative way to guess type: try to insert a string vs number
}

test();
