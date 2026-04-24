
const { createClient } = require('@supabase/supabase-js');

// Use env variables if available, otherwise hardcode for this check
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vckfndfivovqxtgihbvy.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is missing');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function checkUsers() {
    console.log('Checking for Superusers and Gopal...');
    
    // Check Shri and Hari by ID
    const SHRI_ID = 'f00f00f0-0000-0000-0000-000000000002';
    const HARI_ID = 'f00f00f0-0000-0000-0000-000000000001';
    
    const { data: superusers, error: superError } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .in('id', [SHRI_ID, HARI_ID]);
    
    if (superError) console.error('Error fetching superusers:', superError);
    else console.log('Superusers found:', superusers);

    // Check for Gopal
    const { data: gopal, error: gopalError } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .or('username.ilike.%gopal%,display_name.ilike.%gopal%');
    
    if (gopalError) console.error('Error fetching Gopal:', gopalError);
    else console.log('Gopal users found:', gopal);

    // Check total profile count
    const { count, error: countError } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true });
    
    if (countError) console.error('Error fetching count:', countError);
    else console.log('Total profiles in system:', count);
}

checkUsers();
