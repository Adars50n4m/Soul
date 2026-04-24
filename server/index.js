const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const R2Service = require('./services/r2Service');
require('dotenv').config();

// Initialize Supabase (requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey && !supabaseKey.includes('ADD_YOUR')) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase initialized');
} else {
    console.warn('⚠️ Supabase credentials missing or placeholders used. Some features (status metadata sync) will be limited.');
}

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max

const app = express();
app.use(cors());
app.use(express.json());

const SUPERUSERS = [
    { id: 'f00f00f0-0000-0000-0000-000000000002', username: 'shri', display_name: 'Shri', avatar_url: 'https://avatar.iran.liara.run/public/boy?username=shri' },
    { id: 'f00f00f0-0000-0000-0000-000000000001', username: 'hari', display_name: 'Hari', avatar_url: 'https://avatar.iran.liara.run/public/boy?username=hari' }
];

app.get('/', (req, res) => res.send('<html><body style="background: white; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif;"><h1>✅ Soul sync server running</h1></body></html>'));

// Health check for Supabase and R2
app.get('/health', async (req, res) => {
    const status = {
        server: 'online',
        timestamp: new Date().toISOString(),
        supabase: supabase ? 'initialized' : 'missing_credentials',
        r2: R2Service.isConfigured ? 'initialized' : 'missing_credentials'
    };
    
    if (!supabase) {
        return res.status(503).json({ ...status, error: 'Database connection not initialized' });
    }
    
    try {
        const { error } = await supabase.from('profiles').select('count', { count: 'exact', head: true }).limit(1);
        if (error) throw error;
        res.json(status);
    } catch (err) {
        console.error('Health check DB error:', err);
        res.status(500).json({ ...status, database: 'unreachable', error: err.message });
    }
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Basic HTTP routes for R2 Pre-Signed URLs
app.post('/api/media/presign-upload', async (req, res) => {
    try {
        const { fileName, contentType } = req.body;
        if (!fileName) return res.status(400).json({ error: 'fileName is required' });

        const key = `uploads/${Date.now()}-${fileName}`;
        const presignedUrl = await R2Service.generateUploadPresignedUrl(key, contentType);
        
        res.json({ presignedUrl, key });
    } catch (err) {
        console.error('Error generating upload url:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/media/presign-download', async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: 'key is required' });

        const presignedUrl = await R2Service.generateDownloadPresignedUrl(key);
        res.json({ presignedUrl });
    } catch (err) {
        console.error('Error generating download url:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/media/delete', async (req, res) => {
    try {
        const { keys } = req.body;
        if (!keys || !Array.isArray(keys)) return res.status(400).json({ error: 'keys array is required' });

        await Promise.all(keys.map(key => R2Service.deleteFile(key)));
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting media:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Direct multipart upload — fallback when R2 Worker is unreachable from mobile
app.post('/api/media/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });

        const folder = req.body.folder || 'uploads';
        const ext = (req.file.originalname || 'file').split('.').pop() || 'bin';
        const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

        await R2Service.uploadBuffer(key, req.file.buffer, req.file.mimetype);
        res.json({ success: true, key });
    } catch (err) {
        console.error('Error uploading media:', err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// REST Fallbacks for Messages
app.post('/api/messages/send', async (req, res) => {
    // Basic REST wrapper for what Socket does
    const { recipientId, message } = req.body;
    if (!recipientId || !message) return res.status(400).json({ error: 'Missing recipientId or message' });

    try {
        if (supabase) {
            await supabase.from('messages').insert({
                id: message.id,
                sender: message.sender_id,
                receiver: recipientId,
                text: message.text,
                media_type: message.media?.type || null,
                media_url: message.media?.url || null,
                media_caption: message.media?.caption || null,
                media_thumbnail: message.media?.thumbnail || null,
                reply_to_id: message.reply_to || null,
                created_at: message.timestamp || new Date().toISOString(),
                status: 'sent'
            });
        }
        
        const outgoingMessage = {
            ...message,
            sender_id: message.sender_id || message.sender,
            receiver_id: message.receiver_id || recipientId,
        };
        io.to(recipientId).emit('message:receive', outgoingMessage);
        res.json({ success: true, localMessageId: message.id });
    } catch (err) {
        console.error('Error in /api/messages/send:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.post('/api/messages/status', async (req, res) => {
    const { senderId, messageId, status } = req.body;
    if (!senderId || !messageId || !status) return res.status(400).json({ error: 'Missing required fields' });
    
    try {
        if (supabase) {
            await supabase.from('messages').update({ status }).eq('id', messageId);
        }
        io.to(senderId).emit('message:status_update', { senderId, messageId, status });
        res.json({ success: true });
    } catch (err) {
        console.error('Error in /api/messages/status:', err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

app.get('/api/messages/sync', async (req, res) => {
    const { userId, lastSyncAt } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        if (!supabase) return res.json({ success: true, messages: [] });

        let query = supabase.from('messages').select('*').eq('receiver', userId);
        if (lastSyncAt) {
            query = query.gt('created_at', lastSyncAt);
        }
        const { data, error } = await query;
        if (error) throw error;
        
        // Transform DB schema to Message interface format
        const messages = data.map(dbMsg => ({
            id: dbMsg.id,
            sender_id: dbMsg.sender,
            text: dbMsg.text,
            media: dbMsg.media_url ? { type: dbMsg.media_type, url: dbMsg.media_url, caption: dbMsg.media_caption } : undefined,
            reply_to: dbMsg.reply_to_id,
            timestamp: dbMsg.created_at,
            status: dbMsg.status
        }));
        
        res.json({ success: true, messages });
    } catch (err) {
        console.error('Error in /api/messages/sync:', err);
        res.status(500).json({ error: 'Sync failed' });
    }
});

// REST Fallbacks for Statuses
app.post('/api/status/create', async (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status object required' });
    
    try {
        // 1. Attempt to store metadata in Supabase if client is initialized
        if (supabase) {
            try {
                await supabase.from('statuses').insert({
                    id: status.id,
                    user_id: status.userId,
                    user_name: status.userName,
                    user_avatar: status.userAvatar,
                    media_key: status.mediaUrl || status.media_key, // Standardizing to media_key
                    media_type: status.mediaType,
                    caption: status.caption,
                    likes: status.likes || [],
                    views: status.views || [],
                    music: status.music || null,
                    created_at: status.createdAt,
                    expires_at: status.expiresAt
                });
                console.log(`✅ Status metadata saved for user ${status.userId}`);
            } catch (dbErr) {
                console.warn('⚠️ Failed to save status metadata to Supabase (Database Error):', dbErr.message);
                io.emit('status:new', status); // Broadcast for live clients
                throw dbErr; // Let the mobile app handle the DB fallback
            }
        }
        
        // 2. Broadcast to everyone (or specific contacts via rooms)
        // For now, simple global broadcast that connected clients filter
        io.emit('status:new', status); 
        console.log(`📡 Broadcasted status:new for user ${status.userId}`);
        
        res.json({ success: true, broadcasted: true });
    } catch (err) {
        console.error('Fatal error in /api/status/create:', err);
        res.status(500).json({ error: 'Failed to create status' });
    }
});
// Record status view and broadcast
app.post('/api/status/view', async (req, res) => {
    const { statusId, viewerId, ownerId } = req.body;
    if (!statusId || !viewerId || !ownerId) return res.status(400).json({ error: 'Missing required fields' });

    try {
        // 1. Update Supabase if available
        if (supabase) {
            try {
                // Use RPC or array append to add viewerId to views array
                await supabase.rpc('append_viewer', { status_id: statusId, viewer_id: viewerId });
            } catch (dbErr) {
                console.warn('⚠️ Failed to save status view to Supabase:', dbErr.message);
            }
        }

        // 2. Broadcast to owner so they see viewer count increment
        io.to(ownerId).emit('status:view_update', { statusId, viewerId });
        console.log(`👁️ Status ${statusId} viewed by ${viewerId}, notified owner ${ownerId}`);

        res.json({ success: true });
    } catch (err) {
        console.error('Fatal error in /api/status/view:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// Middleware to authenticate user via Header (Dev/Prototype style)
const authenticateUser = (req, res, next) => {
    const userId = req.headers['x-user-id'] || req.query?.userId || req.body?.userId;
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: No user ID provided' });
    }
    req.user = { id: userId };
    next();
};

// --- USER DISCOVERY & CONNECTION ENDPOINTS ---

// 1. Search Users
app.get('/api/users/search', authenticateUser, async (req, res) => {
    const { query } = req.query;
    const currentUserId = req.user.id;

    if (!query || query.length < 2) {
        return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    try {
        if (!supabase) {
            console.error('[Supabase] ❌ Search/Connections aborted: Supabase client not initialized. Check your server .env file.');
            return res.status(503).json({ error: 'Database service unavailable' });
        }

        // Fetch users matching query from DB
        const { data: dbUsers, error } = await supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url, is_online, last_seen')
            .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
            .neq('id', currentUserId)
            .limit(20);

        if (error) {
            console.error('[Search] Profile fetch error:', error);
            throw error;
        }

        // Manually inject hardcoded superusers if they match the query
        const queryLower = query.toLowerCase();
        const matchingSuperusers = SUPERUSERS.filter(u => 
            u.id !== currentUserId && 
            (u.username.toLowerCase().includes(queryLower) || u.display_name.toLowerCase().includes(queryLower)) &&
            !(dbUsers || []).some(dbU => dbU.id === u.id)
        );

        const validatedDbUsers = [];
        for (const user of dbUsers || []) {
            try {
                const { data: authUserData, error: authUserError } = await supabase.auth.admin.getUserById(user.id);
                if (!authUserError && authUserData?.user) {
                    validatedDbUsers.push(user);
                }
            } catch (_) {
                // Ignore orphaned profile rows that no longer map to auth.users
            }
        }

        const users = [...matchingSuperusers, ...validatedDbUsers];

        console.log(`[Search] Found ${users?.length || 0} matching users for query "${query}" (included ${matchingSuperusers.length} superusers)`);

        // Fetch connection status for these users relative to current user
        const { data: requests } = await supabase.from('connection_requests')
            .select('*')
            .or(`sender_id.eq.${currentUserId},receiver_id.eq.${currentUserId}`)
            .filter('status', 'in', '("pending", "rejected")');

        const { data: connections } = await supabase.from('connections')
            .select('*')
            .or(`user_1_id.eq.${currentUserId},user_2_id.eq.${currentUserId}`);

        const enrichedUsers = users.map(u => {
            let status = 'not_connected';
            
            // Check established connections
            const isConnected = connections?.some(c => c.user_1_id === u.id || c.user_2_id === u.id);
            if (isConnected) {
                status = 'connected';
            } else {
                // Check pending/rejected requests
                const reqData = requests?.find(r => 
                    (r.sender_id === currentUserId && r.receiver_id === u.id) || 
                    (r.sender_id === u.id && r.receiver_id === currentUserId)
                );
                
                if (reqData) {
                    if (reqData.status === 'pending') {
                        status = (reqData.sender_id === currentUserId) ? 'request_sent' : 'request_received';
                    } else if (reqData.status === 'rejected') {
                        // If rejected, treat as not connected so they can try again 
                        // as requested: "request cancle ho jayega... uss user ko wapis bhejna pdega"
                        status = 'not_connected';
                    }
                }
            }
            
            if (status !== 'not_connected') {
                console.log(`[Search] User ${u.username} status for ${currentUserId}: ${status}`);
            }
            
            return { ...u, connectionStatus: status };
        });

        res.json({ success: true, users: enrichedUsers });
    } catch (err) {
        console.error('[Search] ❌ Fatal error searching users:', err);
        res.status(500).json({ error: 'Search failed', details: err.message });
    }
});

// 2. Send Connection Request (with alias for plural robustness)
app.post(['/api/connections/request', '/api/connections/requests'], authenticateUser, async (req, res) => {
    const { receiverId, message } = req.body;
    const senderId = req.user.id;

    if (!receiverId) return res.status(400).json({ error: 'receiverId is required' });
    if (senderId === receiverId) return res.status(400).json({ error: 'Cannot connect with yourself' });

    let targetId = receiverId;
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId);

    try {
        if (!supabase) {
            console.error('[Supabase] ❌ Search/Connections aborted: Supabase client not initialized. Check your server .env file.');
            return res.status(503).json({ error: 'Database service unavailable' });
        }

        // If targetId is a username, resolve it to a UUID from the profiles table
        if (!isUUID) {
            const { data: profile, error: profileErr } = await supabase
                .from('profiles')
                .select('id')
                .eq('username', targetId)
                .maybeSingle();
            
            if (profileErr || !profile) {
                console.warn(`[Connections] ⚠️ Failed to resolve username "${targetId}" to UUID:`, profileErr?.message);
                return res.status(404).json({ error: `User "${targetId}" not found in our database.` });
            }
            targetId = profile.id;
        }

        // Check if already connected or request pending
        const { data: existing } = await supabase
            .from('connection_requests')
            .select('id, status')
            .match({ sender_id: senderId, receiver_id: targetId })
            .eq('status', 'pending')
            .maybeSingle();

        if (existing) return res.status(400).json({ error: 'Request already pending' });

        const { data, error } = await supabase
            .from('connection_requests')
            .insert({
                sender_id: senderId,
                receiver_id: targetId,
                message,
                status: 'pending'
            })
            .select()
            .single();

        if (error) throw error;

        // Fetch sender username for notification
        const { data: sender } = await supabase.from('profiles').select('username').eq('id', senderId).single();

        // Emit socket notification to receiver
        io.to(targetId).emit('connection:request_received', {
            request: data,
            senderId: senderId,
            senderName: sender?.username || 'Someone'
        });

        res.json({ success: true, request: data });
    } catch (err) {
        console.error('Error sending request:', err);
        res.status(500).json({ error: 'Failed to send request' });
    }
});

// 2.5 Get Pending Requests
app.get('/api/connections/requests', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    try {
        if (!supabase) {
            console.error('[Supabase] ❌ Search/Connections aborted: Supabase client not initialized. Check your server .env file.');
            return res.status(503).json({ error: 'Database service unavailable' });
        }

        // Fetch both incoming and outgoing pending requests
        const { data: requests, error } = await supabase
            .from('connection_requests')
            .select('*')
            .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
            .eq('status', 'pending');

        if (error) throw error;

        // Fetch profiles of all involved users (senders for incoming, receivers for outgoing)
        const userIds = new Set();
        requests.forEach(r => {
            userIds.add(r.sender_id);
            userIds.add(r.receiver_id);
        });
        // Remove current user from the list to fetch only others
        userIds.delete(userId);

        const { data: profiles } = await supabase
            .from('profiles')
            .select('id, username, display_name, name, avatar_url')
            .in('id', Array.from(userIds));

        const incoming = requests
            .filter(r => r.receiver_id === userId)
            .map(r => ({
                ...r,
                sender: profiles?.find(p => p.id === r.sender_id) || { id: r.sender_id, username: 'Unknown' }
            }));

        const outgoing = requests
            .filter(r => r.sender_id === userId)
            .map(r => ({
                ...r,
                receiver: profiles?.find(p => p.id === r.receiver_id) || { id: r.receiver_id, username: 'Unknown' }
            }));

        res.json({ success: true, incoming, outgoing });
    } catch (err) {
        console.error('Error fetching requests:', err);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// 3. Accept Connection Request
app.put('/api/connections/request/:requestId/accept', authenticateUser, async (req, res) => {
    const { requestId } = req.params;
    const userId = req.user.id;

    try {
        if (!supabase) {
            console.error('[Supabase] ❌ Search/Connections aborted: Supabase client not initialized. Check your server .env file.');
            return res.status(503).json({ error: 'Database service unavailable' });
        }

        // 1. Verify request exists and is for this user
        const { data: request, error: fetchErr } = await supabase
            .from('connection_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        if (fetchErr || !request) return res.status(404).json({ error: 'Request not found' });
        if (request.receiver_id !== userId) return res.status(403).json({ error: 'Not authorized to accept this request' });
        if (request.status !== 'pending') return res.status(400).json({ error: 'Request is no longer pending' });

        // 2. Update request status
        await supabase
            .from('connection_requests')
            .update({ status: 'accepted', responded_at: new Date().toISOString() })
            .eq('id', requestId);

        // 3. Create connection record (user_1_id < user_2_id)
        const [u1, u2] = [request.sender_id, request.receiver_id].sort();
        const { data: connection, error: connErr } = await supabase
            .from('connections')
            .insert({ user_1_id: u1, user_2_id: u2 })
            .select()
            .single();

        if (connErr) throw connErr;
        
        // Fetch receiver (me) username for notification
        const { data: receiver } = await supabase.from('profiles').select('username').eq('id', userId).single();

        // 4. Notify sender
        io.to(request.sender_id).emit('connection:request_accepted', {
            connection,
            receiverId: userId,
            receiverName: receiver?.username || 'Someone'
        });

        res.json({ success: true, connection });
    } catch (err) {
        console.error('Error accepting request:', err);
        res.status(500).json({ error: 'Failed to accept request' });
    }
});

// 4. Reject/Cancel Connection Request
app.put('/api/connections/request/:requestId/reject', authenticateUser, async (req, res) => {
    const { requestId } = req.params;
    const userId = req.user.id;

    try {
        if (!supabase) {
            console.error('[Supabase] ❌ Search/Connections aborted: Supabase client not initialized. Check your server .env file.');
            return res.status(503).json({ error: 'Database service unavailable' });
        }

        const { error } = await supabase
            .from('connection_requests')
            .update({ status: 'rejected', responded_at: new Date().toISOString() })
            .match({ id: requestId, receiver_id: userId });

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('Error rejecting request:', err);
        res.status(500).json({ error: 'Failed to reject request' });
    }
});

// 4.5 Cancel Connection Request (Outgoing)
app.delete('/api/connections/request/:requestId/cancel', authenticateUser, async (req, res) => {
    const { requestId } = req.params;
    const userId = req.user.id;

    try {
        if (!supabase) {
            console.error('[Supabase] ❌ Search/Connections aborted: Supabase client not initialized. Check your server .env file.');
            return res.status(503).json({ error: 'Database service unavailable' });
        }

        const { error } = await supabase
            .from('connection_requests')
            .delete()
            .match({ id: requestId, sender_id: userId, status: 'pending' });

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('Error canceling request:', err);
        res.status(500).json({ error: 'Failed to cancel request' });
    }
});

// 5. Get My Connections
app.get('/api/connections', authenticateUser, async (req, res) => {
    const userId = req.user.id;

    try {
        if (!supabase) {
            console.error('[Supabase] ❌ Search/Connections aborted: Supabase client not initialized. Check your server .env file.');
            return res.status(503).json({ error: 'Database service unavailable' });
        }

        const { data: conns, error } = await supabase
            .from('connections')
            .select(`
                id,
                user_1_id,
                user_2_id,
                is_favorite,
                custom_name,
                mute_notifications,
                connected_at
            `)
            .or(`user_1_id.eq.${userId},user_2_id.eq.${userId}`);

        if (error) throw error;
        if (!Array.isArray(conns) || conns.length === 0) {
            return res.json({ success: true, connections: [] });
        }

        // Fetch user profiles manually for now (to avoid complex joins in one go)
        const otherUserIds = conns.map(c => c.user_1_id === userId ? c.user_2_id : c.user_1_id);
        let profiles = [];
        if (otherUserIds.length > 0) {
            const { data: fetchedProfiles, error: profilesError } = await supabase
                .from('profiles')
                .select('id, username, display_name, avatar_url, is_online')
                .in('id', otherUserIds);

            if (profilesError) throw profilesError;
            profiles = fetchedProfiles || [];
        }

        // Flatten: return the "other" user
        const connections = conns.map(c => {
            const otherUserId = c.user_1_id === userId ? c.user_2_id : c.user_1_id;
            const otherUser = profiles?.find(p => p.id === otherUserId);
            return {
                connection_id: c.id,
                ...(otherUser || { id: otherUserId, username: 'Unknown' }),
                is_favorite: c.is_favorite,
                custom_name: c.custom_name,
                mute_notifications: c.mute_notifications,
                connected_at: c.connected_at
            };
        });

        res.json({ success: true, connections });
    } catch (err) {
        console.error('[Connections] ❌ Error fetching connections for user', userId, ':', err);
        res.status(500).json({ 
            error: 'Failed to fetch connections', 
            details: err.message,
            hint: !supabase ? 'Supabase client missing' : 'Check DB table connections'
        });
    }
});

// 6. Unfriend / Delete Connection
app.delete('/api/connections/:partnerId', authenticateUser, async (req, res) => {
    const { partnerId } = req.params;
    const userId = req.user.id;

    try {
        if (!supabase) throw new Error('Supabase client not initialized');

        // 1. Delete established connection
        const [u1, u2] = [userId, partnerId].sort();
        const { error: deleteConnErr } = await supabase
            .from('connections')
            .delete()
            .match({ user_1_id: u1, user_2_id: u2 });

        if (deleteConnErr) throw deleteConnErr;

        // 2. Also clean up any connection requests so they can "start fresh"
        await supabase
            .from('connection_requests')
            .delete()
            .or(`and(sender_id.eq.${userId},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${userId})`);

        console.log(`🗑️ User ${userId} unfriended ${partnerId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting connection:', err);
        res.status(500).json({ error: 'Failed to unfriend contact' });
    }
});
// Track active socket ID per user to prevent duplicate room members
const userSocketMap = new Map(); // userId -> socketId

io.on('connection', (socket) => {
    console.log(`📡 New Socket Connection: ${socket.id} (Total: ${io.engine.clientsCount})`);

    // User authenticates/identifies themselves
    socket.on('register', (userId) => {
        if (!userId) {
            console.warn(`⚠️ Register event received with no userId from socket ${socket.id}`);
            return;
        }

        // If another socket is already registered for this user, kick it out of the room
        // This prevents duplicate deliveries when the client reconnects
        const existingSocketId = userSocketMap.get(userId);
        if (existingSocketId && existingSocketId !== socket.id) {
            const existingSocket = io.sockets.sockets.get(existingSocketId);
            if (existingSocket) {
                existingSocket.leave(userId);
                console.log(`🔄 Ejected stale socket ${existingSocketId} from room "${userId}"`);
            }
        }

        socket.userId = userId;
        userSocketMap.set(userId, socket.id);
        socket.join(userId);
        console.log(`👤 User "${userId}" registered to socket ${socket.id}`);
    });

    // Clean up when socket disconnects
    socket.on('disconnect', () => {
        if (socket.userId) {
            // Only remove from map if this is still the current socket for this user
            if (userSocketMap.get(socket.userId) === socket.id) {
                userSocketMap.delete(socket.userId);
                console.log(`👋 User "${socket.userId}" disconnected (socket ${socket.id})`);
            }
        }
    });

    // Chat events
    socket.on('message:send', async (data, ackCallback) => {
        // Broadcasts exact message to recipient's room
        // Data format: { recipientId, message: {...} }
        if (data.recipientId && data.message) {
            
            // 1. Store temporarily in Supabase Ephemeral DB if available
            if (supabase) {
                try {
                    await supabase.from('messages').insert({
                        id: data.message.id,
                        sender: data.message.sender_id,
                        receiver: data.recipientId,
                        text: data.message.text,
                        media_type: data.message.media?.type || null,
                        media_url: data.message.media?.url || null,
                        media_caption: data.message.media?.caption || null,
                        media_thumbnail: data.message.media?.thumbnail || null,
                        reply_to_id: data.message.media?.reply_to || data.message.reply_to || null,
                        created_at: data.message.timestamp || new Date().toISOString(),
                        status: 'sent'
                    });
                } catch (err) {
                    console.error('Failed to save message temporarily to Supabase:', err.message);
                }
            }

            // 2. Emit to recipient with normalized payload shape for all clients
            const outgoingMessage = {
                ...data.message,
                sender_id: data.message.sender_id || data.message.sender,
                receiver_id: data.message.receiver_id || data.recipientId,
            };
            io.to(data.recipientId).emit('message:receive', outgoingMessage);
            console.log(`💬 Message from ${data.message.sender_id} to ${data.recipientId} broadcasted`);
            
            // 3. Confirm to sender it was processed
            if (typeof ackCallback === 'function') {
                ackCallback({ success: true, localMessageId: data.message.id });
            }
        } else {
            if (typeof ackCallback === 'function') {
                ackCallback({ success: false, error: 'Invalid data format' });
            }
        }
    });

    // Delivered & Read receipts
    socket.on('message:status', async (data) => {
        // Data format: { senderId, messageId, status: 'delivered' | 'read' }
        if (data.senderId) {
            // Update temporary DB reference
            if (supabase) {
                try {
                    await supabase.from('messages').update({ status: data.status }).eq('id', data.messageId);
                } catch (err) {
                    console.error('Failed to update status in Supabase:', err.message);
                }
            }

            io.to(data.senderId).emit('message:status_update', data);
        }
    });

    // Real-time Reactions
    socket.on('message:reaction', async (data) => {
        // data: { recipientId, messageId, reaction }
        if (data.recipientId && data.messageId) {
            const senderId = socket.userId || 'Unknown';
            console.log(`✨ Reaction [${data.reaction}] from ${senderId} on ${data.messageId} -> Recipient: ${data.recipientId}`);
            
            // Sync to DB
            if (supabase) {
                try {
                    const { error } = await supabase.from('messages').update({ reaction: data.reaction || null }).eq('id', data.messageId);
                    if (error && error.code !== '22P02') console.error('DB Reaction error:', error.message);
                } catch (err) {}
            }

            // Verify if recipient is in room
            const room = io.sockets.adapter.rooms.get(data.recipientId);
            const isConnected = room && room.size > 0;
            console.log(`📡 Broadcast status: ${isConnected ? 'Recipient Online' : 'Recipient Offline (Queued)'}`);

            // Forward to recipient
            io.to(data.recipientId).emit('message:reaction', {
                messageId: data.messageId,
                reaction: data.reaction,
                senderId: senderId
            });
        }
    });

    // New Status broadcast
    socket.on('status:new', (statusData) => {
        // Broadcast new status to all clients (in prod, limit to contacts)
        socket.broadcast.emit('status:new', statusData);
    });

    // Presence & Typing events
    socket.on('user:online', (data) => {
        // { userId, isOnline }
        socket.broadcast.emit('user:online', data);
    });

    socket.on('user:typing', (data) => {
        // { senderId, recipientId, isTyping }
        if (data.recipientId) {
            io.to(data.recipientId).emit('user:typing', data);
        }
    });

    // Music playback sync
    socket.on('music:playback_update', (data) => {
        // Broadcast to specific recipient if provided, otherwise broadcast to everyone
        if (data.recipientId) {
            console.log(`🎵 Syncing music to ${data.recipientId}`);
            io.to(data.recipientId).emit('music:playback_update', data);
        } else {
            socket.broadcast.emit('music:playback_update', data);
        }
    });

    // --- WebRTC CALLING SIGNALS ---
    
    // 1. Initial Call Signaling (SDP Offer)
    socket.on('offer', (data) => {
        const target = data.recipientId || data.calleeId;
        if (target) {
            console.log(`📞 [Offer] from ${socket.userId || 'unknown'} to ${target}`);
            io.to(target).emit('offer', data);
        }
    });

    // 2. Call Response (SDP Answer)
    socket.on('answer', (data) => {
        const target = data.recipientId || data.callerId;
        if (target) {
            console.log(`📞 [Answer] from ${socket.userId || 'unknown'} to ${target} for call ${data.callId}`);
            io.to(target).emit('answer', data);
        }
    });

    // 3. ICE Candidate Exchange
    socket.on('ice-candidate', (data) => {
        const target = data.recipientId || (socket.userId === data.callerId ? data.calleeId : data.callerId);
        if (target) {
            io.to(target).emit('ice-candidate', data);
        }
    });

    // 4. Call Life-cycle Events
    socket.on('call-request', (data) => {
        const target = data.recipientId || data.calleeId;
        if (target) {
            console.log(`🔔 [Call Request] ${data.callId} to ${target}`);
            io.to(target).emit('call-request', data);
        }
    });

    socket.on('call-ringing', (data) => {
        const target = data.recipientId || data.callerId;
        if (target) {
            console.log(`🔕 [Call Ringing] to ${target}`);
            io.to(target).emit('call-ringing', data);
        }
    });

    socket.on('call-accept', (data) => {
        const target = data.recipientId || data.callerId;
        if (target) {
            console.log(`✅ [Call Accepted] ${data.callId}, notifying ${target}`);
            io.to(target).emit('call-accept', data);
        }
    });

    socket.on('call-reject', (data) => {
        const target = data.recipientId || data.callerId;
        if (target) {
            console.log(`❌ [Call Rejected] ${data.callId}, notifying ${target}`);
            io.to(target).emit('call-reject', data);
        }
    });

    socket.on('call-end', (data) => {
        console.log(`🛑 [Call Ended] ${data.callId}`);
        const target1 = data.recipientId;
        const target2 = (socket.userId === data.callerId) ? data.calleeId : data.callerId;
        
        if (target1) io.to(target1).emit('call-end', data);
        if (target2 && target2 !== target1) io.to(target2).emit('call-end', data);
    });

    // 5. Media Toggle Events
    socket.on('video-toggle', (data) => {
        const target = data.recipientId || (socket.userId === data.callerId ? data.calleeId : data.callerId);
        if (target) io.to(target).emit('video-toggle', data);
    });

    socket.on('audio-toggle', (data) => {
        const target = data.recipientId || (socket.userId === data.callerId ? data.calleeId : data.callerId);
        if (target) io.to(target).emit('audio-toggle', data);
    });
});

// Periodic Cleanup: 5-minute auto-delete for delivered/read messages
setInterval(async () => {
    if (!supabase) return; // Skip cleanup if DB is not configured
    try {
        const nowIso = new Date().toISOString();
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        
        // 1. Find messages older than 5 minutes that have been delivered
        const { data: oldMessages, error: msgError } = await supabase
            .from('messages')
            .select('id, media_url')
            .in('status', ['delivered', 'read'])
            .lt('created_at', fiveMinutesAgo);
            
        if (msgError) throw msgError;
        
        if (oldMessages && oldMessages.length > 0) {
            console.log(`🧹 Auto-deleting ${oldMessages.length} ephemeral messages...`);
            
            // Delete associated R2 media first
            const msgMediaKeys = oldMessages.map(m => m.media_url).filter(url => url && !url.startsWith('data:'));
            if (msgMediaKeys.length > 0) {
               await Promise.all(
                   msgMediaKeys.map(key => R2Service.deleteFile(key).catch(e => console.error('R2 delete error (msg cleanup):', e)))
               );
            }
            
            // Delete from Supabase
            const msgIds = oldMessages.map(m => m.id);
            await supabase.from('messages').delete().in('id', msgIds);
            console.log(`✅ Message cleanup complete for ${msgIds.length} messages.`);
        }

        // 2. Find statuses older than 24 hours (where expires_at < now)
        const { data: expiredStatuses, error: statusError } = await supabase
            .from('statuses')
            .select('id, media_url')
            .lt('expires_at', nowIso);
            
        if (statusError) throw statusError;

        if (expiredStatuses && expiredStatuses.length > 0) {
            console.log(`🧹 Auto-deleting ${expiredStatuses.length} expired statuses...`);

            // Delete associated R2 media first
            const statusMediaKeys = expiredStatuses.map(s => s.media_url).filter(url => url && !url.startsWith('data:'));
            if (statusMediaKeys.length > 0) {
               await Promise.all(
                   statusMediaKeys.map(key => R2Service.deleteFile(key).catch(e => console.error('R2 delete error (status cleanup):', e)))
               );
            }

            // Delete from Supabase
            const statusIds = expiredStatuses.map(s => s.id);
            await supabase.from('statuses').delete().in('id', statusIds);
            console.log(`✅ Status cleanup complete for ${statusIds.length} statuses.`);
        }

    } catch (err) {
        console.error('Auto-delete cron failed:', err);
    }
}, 60 * 1000); // Check every minute

// ─────────────────────────────────────────────────────────────────────────────
// 🛡️ CLEANUP DAEMON (5-Minute Server Storage Limit)
// ─────────────────────────────────────────────────────────────────────────────
// This background process enforces the user's policy: "5 min hi server par hoga".
// It periodically purges aged messages and their media from R2/Supabase.
// ─────────────────────────────────────────────────────────────────────────────

const CLEANUP_INTERVAL_MS = 60 * 1000; // Check every 1 minute
const RETENTION_WINDOW = '30 minutes'; 

async function runCleanupDaemon() {
    if (!supabase) {
        console.warn('[CleanupDaemon] Supabase not initialized, skipping cleanup...');
        return;
    }

    const startTime = Date.now();
    console.log(`[CleanupDaemon] Starting purge for content older than ${RETENTION_WINDOW}...`);

    try {
        // 1. Fetch content that needs to be deleted from R2
        // We use the helper function created in migration 0007
        const { data: expiredItems, error: fetchErr } = await supabase
            .rpc('get_expired_content', { view_window: RETENTION_WINDOW });

        if (fetchErr) throw fetchErr;

        if (expiredItems && expiredItems.length > 0) {
            console.log(`[CleanupDaemon] Found ${expiredItems.length} items to purge from storage.`);
            
            // 2. Identify all unique media keys (urls and thumbnails)
            const keysToDelete = new Set();
            expiredItems.forEach(item => {
                if (item.media_url && !item.media_url.startsWith('http')) {
                    keysToDelete.add(item.media_url);
                }
                if (item.media_thumbnail && !item.media_thumbnail.startsWith('http')) {
                    keysToDelete.add(item.media_thumbnail);
                }
            });

            // 3. Delete files from R2
            if (keysToDelete.size > 0) {
                console.log(`[CleanupDaemon] Deleting ${keysToDelete.size} files from R2...`);
                await Promise.allSettled(
                    Array.from(keysToDelete).map(key => R2Service.deleteFile(key))
                );
            }
        }

        // 4. Purge the message records from the database
        const { data: deletedCount, error: purgeErr } = await supabase
            .rpc('purge_expired_messages', { view_window: RETENTION_WINDOW });

        if (purgeErr) throw purgeErr;

        if (deletedCount > 0 || (expiredItems && expiredItems.length > 0)) {
            console.log(`[CleanupDaemon] Purge complete. Deleted ${deletedCount} rows from DB. Time taken: ${Date.now() - startTime}ms`);
        }
    } catch (err) {
        console.error('[CleanupDaemon] Error during cleanup cycle:', err.message);
    }
}

// Start the daemon
console.log(`[CleanupDaemon] Initializing background cleanup with ${RETENTION_WINDOW} retention window.`);
setInterval(runCleanupDaemon, CLEANUP_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Listen on all interfaces so physical devices can connect
server.listen(PORT, HOST, () => {
    console.log(`Soul sync server running on ${HOST}:${PORT}`);
    console.log(`Local network URL: http://192.168.1.38:${PORT}`);
});
