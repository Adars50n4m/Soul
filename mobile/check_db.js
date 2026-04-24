
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://xuipxbyvsawhuldopvjn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9cVY_6oQHMZnV9CaxmMs9Q_7QlUxqlD';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function check() {
    console.log('Checking profiles...');
    const { data, error } = await supabase.from('profiles').select('id, username, display_name');
    if (error) {
        console.error('Error:', error);
    } else {
        console.log('Profiles found:', data.length);
        console.log(JSON.stringify(data, null, 2));
    }
}

check();
