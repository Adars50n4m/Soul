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

const app = express();
app.use(cors());
app.use(express.json());

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

// REST Fallbacks for Messages
app.post('/api/messages/send', async (req, res) => {
    // Basic REST wrapper for what Socket does
    const { recipientId, message } = req.body;
    if (!recipientId || !message) return res.status(400).json({ error: 'Missing recipientId or message' });

    try {
        await supabase.from('messages').insert({
            id: message.id,
            sender: message.sender_id,
            receiver: recipientId,
            text: message.text,
            media_type: message.media?.type || null,
            media_url: message.media?.url || null,
            media_caption: message.media?.caption || null,
            reply_to_id: message.reply_to || null,
            created_at: message.timestamp || new Date().toISOString(),
            status: 'sent'
        });
        
        io.to(recipientId).emit('message:receive', message);
        res.json({ success: true, localMessageId: message.id });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.post('/api/messages/status', async (req, res) => {
    const { senderId, messageId, status } = req.body;
    if (!senderId || !messageId || !status) return res.status(400).json({ error: 'Missing required fields' });
    
    try {
        await supabase.from('messages').update({ status }).eq('id', messageId);
        io.to(senderId).emit('message:status_update', { senderId, messageId, status });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update status' });
    }
});

app.get('/api/messages/sync', async (req, res) => {
    const { userId, lastSyncAt } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
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
                    media_url: status.mediaUrl,
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
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // User authenticates/identifies themselves
    socket.on('register', (userId) => {
        socket.join(userId);
        console.log(`User ${userId} registered to socket ${socket.id}`);
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
                        reply_to_id: data.message.reply_to || null,
                        created_at: data.message.timestamp || new Date().toISOString(),
                        status: 'sent'
                    });
                } catch (err) {
                    console.error('Failed to save message temporarily to Supabase:', err.message);
                }
            }

            // 2. Emit to recipient
            io.to(data.recipientId).emit('message:receive', data.message);
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
            try {
                await supabase.from('messages').update({ status: data.status }).eq('id', data.messageId);
            } catch (err) {
                console.error('Failed to update status in Supabase:', err);
            }

            io.to(data.senderId).emit('message:status_update', data);
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

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SoulSync sync server running on port ${PORT}`);
});
