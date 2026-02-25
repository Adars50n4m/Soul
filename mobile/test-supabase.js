const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://xuipxbyvsawhuldopvjn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9cVY_6oQHMZnV9CaxmMs9Q_7QlUxqlD';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const channel = supabase.channel('test-channel');

channel.subscribe((status, err) => {
    console.log('Status:', status);
    if (err) console.error('Error:', err);
    process.exit(0);
});
