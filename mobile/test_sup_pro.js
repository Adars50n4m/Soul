const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://xuipxbyvsawhuldopvjn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9cVY_6oQHMZnV9CaxmMs9Q_7QlUxqlD';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function test() {
    const { data: pData, error: pErr } = await supabase.from('profiles').select('*');
    if (pErr) console.error("Profiles error:", pErr);
    else console.log("Profiles data:", pData);
}
test();
