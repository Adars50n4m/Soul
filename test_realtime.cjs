const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://xuipxbyvsawhuldopvjn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9cVY_6oQHMZnV9CaxmMs9Q_7QlUxqlD';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SHRI_ID = '4d28b137-66ff-4417-b451-b1a421e34b25';
const HARI_ID = '02e52f08-6c1e-497f-93f6-b29c275b8ca4';

async function test() {
  const channel = supabase.channel(`chat_node_test`);
  channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
    console.log("RECEIVED INSERT:", payload);
  }).subscribe((status) => {
    console.log("STATUS:", status);
    if (status === 'SUBSCRIBED') {
      console.log("Now subscribed! Try sending a message from the app.");
      // We will also send a test message ourselves to trigger it
      setTimeout(() => {
        supabase.from('messages').insert({
          sender: SHRI_ID,
          receiver: HARI_ID,
          text: "Test Realtime from Node",
          status: 'sent'
        }).then(res => console.log("Test Msg Result:", res));
      }, 2000);
    }
  });
}

test();
