import { supabase } from '../config/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import { normalizeId } from '../utils/idNormalization';
import { AppState } from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// CALL SERVICE — Supabase Realtime Broadcast signaling
//
// MIGRATION FROM SOCKET.IO:
//   The old CallService used chatService.getSocket() for all signaling.
//   Since ChatService now uses Supabase Realtime (no socket.io), we use
//   Supabase Broadcast channels directly:
//
//   1. PERSONAL CHANNEL: `call_user_{userId}`
//      - Each user subscribes to their own personal channel on initialize()
//      - Incoming call-request, call-ringing, call-reject, call-end arrive here
//
//   2. ROOM CHANNEL: `call_room_{roomId}`
//      - Both users join after call-accept
//      - Carries WebRTC signals: offer, answer, ice-candidate
//      - Also carries call-end/reject for in-call events
//
//   sendSignal() routes to the correct channel automatically.
// ─────────────────────────────────────────────────────────────────────────────

export interface CallSignal {
    type: 'offer' | 'answer' | 'ice-candidate' | 'call-request' | 'call-accept' | 'call-reject' | 'call-end' | 'call-ringing' | 'video-toggle' | 'audio-toggle';
    callId: string;
    callerId: string;
    calleeId: string;
    callType: 'audio' | 'video';
    payload?: any;
    timestamp: string;
    roomId?: string;
    signalId?: string; // Unique ID for cross-path deduplication (Broadcast + DB)
    callerName?: string;
    callerAvatar?: string;
    calleeName?: string;
    calleeAvatar?: string;
}

type CallSignalHandler = (signal: CallSignal) => void;

// Singleton references to survive HMR/Reloads
// These ensure that re-initializing the service doesn't leak old connections
let _personalChannel: RealtimeChannel | null = null;
let _roomChannel: RealtimeChannel | null = null;
let _signalSubscription: RealtimeChannel | null = null;

// Pool for outgoing signals to avoid multiple subscriptions to same target
const _senderChannels = new Map<string, RealtimeChannel>();
let _personalChannelReconnectAttempts = 0;

class CallService {
    private userId: string | null = null;
    private currentUser: { name: string; avatar: string } | null = null;
    
    getUserId(): string | null {
        return this.userId;
    }

    setCurrentCallType(callType: 'audio' | 'video'): void {
        this.currentCallType = callType;
    }

    private listeners: Set<CallSignalHandler> = new Set();
    private statusListeners: Set<(connected: boolean) => void> = new Set();
    private currentRoomId: string | null = null;
    private currentPartnerId: string | null = null;
    private currentCallType: 'audio' | 'video' = 'audio';
    private roomSubscribed: boolean = false;
    private isJoiningRoom: boolean = false;
    private roomSubscribeCallbacks: (() => void)[] = [];
    private signalBuffer: CallSignal[] = [];
    private callTimeoutTimer: NodeJS.Timeout | null = null;
    private readonly CALL_TIMEOUT_MS = 45000; // 45 seconds timeout
    private reconnectTimer: NodeJS.Timeout | null = null;
    private personalChannelSubscribed: boolean = false;
    private processedSignalIds: Set<string> = new Set();
    private signalPollInterval: NodeJS.Timeout | null = null;
    private _fastPollInterval: NodeJS.Timeout | null = null;
    private lastSignalPollAt: string = new Date().toISOString();
    private _appStateSubscription: any = null;
    private _connectionLimitHit: boolean = false;
    private _consecutivePollFailures: number = 0;

    addStatusListener(handler: (connected: boolean) => void): void {
        this.statusListeners.add(handler);
        handler(!!_personalChannel && this.personalChannelSubscribed);
    }

    removeStatusListener(handler: (connected: boolean) => void): void {
        this.statusListeners.delete(handler);
    }

    private notifyStatus(connected: boolean) {
        this.statusListeners.forEach(listener => listener(connected));
    }

    // ── PUBLIC: initialize() ───────────────────────────────────────────────
    //
    // Subscribe to the user's personal broadcast channel.
    // All incoming call signals (call-request, call-ringing, etc.) arrive here.
    initialize(userId: string, user: { name: string, avatar: string } | null = null): void {
        const normalizedUserId = normalizeId(userId);
        this.currentUser = user;
        
        // If same user AND channel is alive and subscribed, skip
        if (this.userId === normalizedUserId && _personalChannel && this.personalChannelSubscribed) {
            return;
        }

        // Clean up existing channel
        if (_personalChannel) {
            console.log('[CallService] Tearing down stale personal channel before re-init');
            try { supabase.removeChannel(_personalChannel); } catch (_) {}
            _personalChannel = null;
            this.personalChannelSubscribed = false;
        }

        // Clear any pending reconnect
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.userId !== normalizedUserId) {
            this.userId = normalizedUserId;
            _personalChannelReconnectAttempts = 0;
            this._connectionLimitHit = false;
            this.processedSignalIds.clear();
        }
        this.lastSignalPollAt = new Date().toISOString();
        this._consecutivePollFailures = 0;
        
        // Only subscribe to realtime if we haven't hit the connection limit
        if (!this._connectionLimitHit) {
            this._subscribePersonalChannel(normalizedUserId);
            this._subscribePersonalDB(normalizedUserId);
        }
        this.startSignalPolling();
        
        // Listen for foreground to poll immediately (clean up previous listener first)
        if (this._appStateSubscription) {
            this._appStateSubscription.remove();
        }
        this._appStateSubscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                this._consecutivePollFailures = 0; // Reset poll failures on foreground
                this.pollForSignals();
                // Reset connection limit flag on foreground (connections may have drained)
                if (this._connectionLimitHit) {
                    console.log('[CallService] App foregrounded — resetting connection limit flag');
                    this._connectionLimitHit = false;
                    _personalChannelReconnectAttempts = 0;
                    if (this.userId) this._subscribePersonalChannel(this.userId);
                }
            }
        });
    }

    private async pollForSignals() {
        if (!this.userId) return;
        // Stop polling if too many consecutive failures (network is down)
        if (this._consecutivePollFailures >= 3) return;
        
        try {
            const { data, error } = await supabase
                .from('call_signals')
                .select('*')
                .eq('receiver_id', this.userId)
                .gt('created_at', this.lastSignalPollAt)
                .order('created_at', { ascending: true });

            if (error) throw error;
            this._consecutivePollFailures = 0; // Reset on success

            if (data && data.length > 0) {
                this.lastSignalPollAt = data[data.length - 1].created_at;
                data.forEach(row => {
                    const signal: CallSignal = {
                        ...(row.payload as any),
                        type: row.type as any,
                        signalId: row.signal_id,
                        callerId: normalizeId(row.sender_id),
                        calleeId: normalizeId(row.receiver_id),
                        timestamp: row.created_at,
                        roomId: (row.payload as any).roomId || (row.payload as any).callId
                    };
                    this.handleIncomingSignal(signal);
                });
            }
        } catch (err) {
            this._consecutivePollFailures++;
            if (this._consecutivePollFailures <= 1) {
                console.log('[CallService] Signal poll failed (will suppress further)');
            }
        }
    }

    private _subscribePersonalDB(userId: string): void {
        if (this._connectionLimitHit) return;
        
        if (_signalSubscription) {
            try { supabase.removeChannel(_signalSubscription); } catch (_) {}
        }

        console.log(`[CallService] 📡 DB fallback enabled for ${userId}`);
        
        _signalSubscription = supabase.channel(`call_signals_realtime_${userId}`)
            .on('postgres_changes', 
                { 
                    event: 'INSERT', 
                    schema: 'public', 
                    table: 'call_signals', 
                    filter: `receiver_id=eq.${userId}` 
                },
                (payload) => {
                    const row = payload.new;
                    const signal: CallSignal = {
                        ...(row.payload as any),
                        type: row.type as any,
                        signalId: row.signal_id,
                        callerId: normalizeId(row.sender_id),
                        calleeId: normalizeId(row.receiver_id),
                        timestamp: row.created_at,
                        roomId: (row.payload as any).roomId || (row.payload as any).callId
                    };
                    this.handleIncomingSignal(signal);
                }
            )
            .subscribe();
    }

    private startSignalPolling() {
        if (this.signalPollInterval) clearInterval(this.signalPollInterval);
        if (this._fastPollInterval) clearInterval(this._fastPollInterval);
        
        // Standard 30s polling (was 10s — too aggressive)
        this.signalPollInterval = setInterval(() => {
            if (this.userId) this.pollForSignals();
        }, 30000);
        
        // Accelerated polling only during active calls
        this._fastPollInterval = setInterval(() => {
            if (this.currentRoomId && (!this.personalChannelSubscribed || !this.roomSubscribed)) {
                this.pollForSignals();
            }
        }, 5000);
    }

    private _subscribePersonalChannel(userId: string): void {
        if (this._connectionLimitHit) return;
        
        const channelName = `call_user_${userId}`;

        if (_personalChannel) {
            try { supabase.removeChannel(_personalChannel); } catch (_) {}
        }

        _personalChannel = supabase.channel(channelName, {
            config: { broadcast: { self: false } },
        });

        _personalChannel.on('broadcast', { event: 'call_signal' }, ({ payload }) => {
            const signal = payload as CallSignal;
            console.log(`📞 [CallService] Received signal [${signal.type}] from ${signal.callerId}`);
            this.handleIncomingSignal(signal);
        });

        // Capture reference to detect stale callbacks
        const thisChannel = _personalChannel;

        _personalChannel.subscribe((status, err) => {
            // STALE CHECK: if channel was replaced, ignore this callback entirely
            if (thisChannel !== _personalChannel) return;
            
            if (status === 'SUBSCRIBED') {
                _personalChannelReconnectAttempts = 0;
                this.personalChannelSubscribed = true;
                this._connectionLimitHit = false;
                this.notifyStatus(true);
                console.log(`[CallService] ✅ Realtime connected`);
            } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                this.personalChannelSubscribed = false;
                this.notifyStatus(false);
                
                if (status === 'CHANNEL_ERROR') {
                    // Mark connection limit hit — stops ALL further realtime attempts
                    this._connectionLimitHit = true;
                    console.log('[CallService] Connection limit hit — all realtime paused until foreground');
                    // Clean up to free resources
                    if (_personalChannel) {
                        try { supabase.removeChannel(_personalChannel); } catch (_) {}
                        _personalChannel = null;
                    }
                    if (_signalSubscription) {
                        try { supabase.removeChannel(_signalSubscription); } catch (_) {}
                        _signalSubscription = null;
                    }
                    return; // Don't retry — wait for foreground
                }
                
                // For CLOSED (not CHANNEL_ERROR): retry with backoff
                if (this.reconnectTimer) return;
                if (_personalChannelReconnectAttempts >= 3) return;

                const delay = Math.min(10000 * Math.pow(2, _personalChannelReconnectAttempts), 60000);
                _personalChannelReconnectAttempts++;
                
                console.log(`[CallService] Retry ${_personalChannelReconnectAttempts}/3 in ${delay / 1000}s`);
                
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    if (this.userId === userId) {
                        this._subscribePersonalChannel(userId);
                    }
                }, delay);
            }
        });
    }

    private handleIncomingSignal(signal: CallSignal) {
        if (!this.userId) return;
        if (!this._shouldProcessSignal(signal)) return;

        const myId = normalizeId(this.userId);
        const senderId = normalizeId(signal.callerId || (signal as any).sender_id);
        const rawSenderId = (signal.callerId || (signal as any).sender_id || '').toString().toLowerCase();
        const rawMyId = (this.userId || '').toString().toLowerCase();

        // [AUTO-CUT FIX] Ignore signals sent by OURSELVES (loopy signaling)
        // We use both normalized and raw ID comparisons to ensure no leaks
        if (senderId === myId || rawSenderId === rawMyId) {
            return;
        }

        // Check for busy state or duplicate call requests
        if (signal.type === 'call-request' && this.currentRoomId) {
            const signalTime = new Date(signal.timestamp).getTime();
            const now = Date.now();
            const ageSeconds = (now - signalTime) / 1000;

            // If age is more than 30s, ignore completely as stale
            if (ageSeconds > 30) {
                console.log(`[CallService] 🕰 Ignoring stale call-request from ${ageSeconds.toFixed(1)}s ago.`);
                return;
            }

            // If we're already in THIS room, it's a legitimate retry/broadcast duplicate
            if (this.currentRoomId === signal.roomId) {
                console.log('[CallService] 🔄 Ignoring duplicate call-request for own active room:', signal.roomId);
                return;
            }

            console.log(`[CallService] 🚫 Busy: auto-rejecting request ${signal.roomId} (current: ${this.currentRoomId})`);
            this.rejectCall(signal);
            return;
        }

        this.notifyListeners(signal);
    }

    private _shouldProcessSignal(signal: CallSignal): boolean {
        // Cross-path deduplication: check if we've already processed this signal
        // We include ROOM ID and TYPE to ensure we don't drop different signals from same user
        const signalKey = signal.signalId || 
            `${signal.type}_${signal.roomId || signal.callId || 'no-room'}_${signal.callerId || 'no-caller'}`;

        if (this.processedSignalIds.has(signalKey)) {
            console.log(`[CallService] 🔁 Duplicate signal [${signal.type}] ignored (Key: ${signalKey.substring(0, 30)}...)`);
            return false;
        }
        this.processedSignalIds.add(signalKey);
        
        // 30s TTL for each signal to allow future calls with same roomId (e.g. redials)
        setTimeout(() => {
            this.processedSignalIds.delete(signalKey);
        }, 30000);

        return true;
    }

    // ── Room channel (for WebRTC signals after call-accept) ────────────────

    private setupRoomListeners(channel: RealtimeChannel, _roomId: string): void {
        channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
            const signal = payload as CallSignal;
            if (!this._shouldProcessSignal(signal)) return;

            console.log(`[CallService] Received room signal [${signal.type}]`);
            this.notifyListeners(signal);

            if (signal.type === 'call-end' || signal.type === 'call-reject') {
                this.cleanup(signal.type);
            }
        });
    }

    private joinRoom(roomId: string, onSubscribed?: () => void) {
        // Guard against simultaneous join attempts for the same room
        if (this.isJoiningRoom && this.currentRoomId === roomId) {
            console.log(`[CallService] Join already in progress for room ${roomId}. Queueing callback.`);
            if (onSubscribed) {
                this.roomSubscribeCallbacks.push(onSubscribed);
            }
            return;
        }

        // Clean up previous room channel completely
        if (_roomChannel) {
            console.log(`[CallService] Cleaning up old room channel before joining new one: ${this.currentRoomId}`);
            supabase.removeChannel(_roomChannel);
            _roomChannel = null;
        }

        console.log(`[CallService] Joining room ${roomId}...`);
        this.currentRoomId = roomId;
        this.roomSubscribed = false;
        this.isJoiningRoom = true;
        this.roomSubscribeCallbacks = [];

        if (onSubscribed) {
            this.roomSubscribeCallbacks.push(onSubscribed);
        }

        _roomChannel = supabase.channel(`call_room_${roomId}`, {
            config: { broadcast: { self: false } },
        });

        this.setupRoomListeners(_roomChannel, roomId);

        const timeout = setTimeout(() => {
            console.warn(`[CallService] Room ${roomId} subscription timeout - proceeding anyway`);
            this.handleJoinSuccess(roomId);
        }, 10000); // 10s for establishement

        _roomChannel.subscribe((status) => {
            console.log(`[CallService] Room ${roomId} subscription status: ${status}`);
            
            if (status === 'SUBSCRIBED') {
                clearTimeout(timeout);
                this.handleJoinSuccess(roomId);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                this.roomSubscribed = false;
                this.isJoiningRoom = false;
                
                // Attempt reconnection on error if we are still supposed to be in this room
                if (this.currentRoomId === roomId) {
                    console.warn(`[CallService] Room ${roomId} error: ${status}. Attempting recovery join...`);
                    setTimeout(() => {
                        if (!this.roomSubscribed && this.currentRoomId === roomId) {
                            this.joinRoom(roomId);
                        }
                    }, 2000);
                }
            } else if (status === 'CLOSED') {
                // CLOSED is normal when we unsubscribe. No recovery needed unless we didn't mean to.
                console.log(`[CallService] Room ${roomId} channel closed.`);
                this.roomSubscribed = false;
                this.isJoiningRoom = false;
            }
        });
    }

    private handleJoinSuccess(roomId: string) {
        if (this.roomSubscribed && this.currentRoomId === roomId) return;
        
        this.roomSubscribed = true;
        this.isJoiningRoom = false;
        
        // 1. Process room callbacks (like starting the call)
        const callbacks = [...this.roomSubscribeCallbacks];
        this.roomSubscribeCallbacks = [];
        console.log(`[CallService] Room ${roomId} joined successfully. Notifying ${callbacks.length} listeners.`);
        callbacks.forEach(cb => cb());

        // 2. Clear out buffered signals immediately upon subscription
        if (this.signalBuffer.length > 0) {
            console.log(`[CallService] 📤 Releasing ${this.signalBuffer.length} buffered room signals...`);
            const signalsToFlush = [...this.signalBuffer];
            this.signalBuffer = [];
            signalsToFlush.forEach(sig => this.sendSignal(sig));
        }
    }

    private startCallTimeout(onTimeout: () => void): void {
        this.clearCallTimeout();
        this.callTimeoutTimer = setTimeout(() => {
            console.warn('[CallService] ⚠️ Call timeout reached - no response from callee');
            onTimeout();
        }, this.CALL_TIMEOUT_MS);
    }

    public clearCallTimeout(): void {
        if (this.callTimeoutTimer) {
            console.log('[CallService] ⏰ Call timeout CLEARED');
            clearTimeout(this.callTimeoutTimer);
            this.callTimeoutTimer = null;
        }
    }

    // ── PUBLIC: startCall() ────────────────────────────────────────────

    async startCall(partnerId: string, callType: 'audio' | 'video'): Promise<string | null> {
        if (!this.userId) return null;

        // Check for basic network connectivity first
        const isReachable = await this.checkRealtimeReachable();
        if (!isReachable) {
            console.warn('[CallService] ⚠️ Signaling server unreachable. Call might fail.');
        }

        // Self-heal: if our personal channel died, re-subscribe before calling
        if (!this.personalChannelSubscribed && this.userId) {
            console.warn('[CallService] ⚠️ Personal channel not SUBSCRIBED — re-initializing before call');
            this.initialize(this.userId);
            // Give it a moment to subscribe
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const roomId = Crypto.randomUUID();
        this.currentRoomId = roomId;
        this.currentPartnerId = partnerId;
        this.currentCallType = callType;

        // Persist call state for crash recovery
        this.persistCallState();

        console.log(`[CallService] Initiating Supabase call to ${partnerId} in room ${roomId}`);

        const signal: CallSignal = {
            type: 'call-request',
            callId: roomId,
            callerId: this.userId!,
            calleeId: partnerId,
            callType,
            roomId,
            callerName: this.currentUser?.name || '',
            callerAvatar: this.currentUser?.avatar || '',
            timestamp: new Date().toISOString()
        };

        // Join the room first so we're ready for the answer
        this.joinRoom(roomId);

        // Ensure polling is active
        this.startSignalPolling();

        // Send call-request to the callee's personal channel
        await this.sendSignal(signal);

        // Start timeout - if no response in 45 seconds, end the call
        this.startCallTimeout(() => {
            this.cleanup('timeout');
        });

        return roomId;
    }

    // ── PUBLIC: acceptCall() ─────────────────────────────────────────────

    async acceptCall(signal: CallSignal): Promise<void> {
        if (!this.userId || !signal.roomId) return;

        console.log(`[CallService] Accepting call from ${signal.callerId} (Supabase)`);
        this.currentRoomId = signal.roomId;
        this.currentPartnerId = signal.callerId;
        this.currentCallType = signal.callType;

        // Clear timeout since call was accepted
        this.clearCallTimeout();

        // Join room only if we are not already in it (or it's a different room)
        // This prevents the 'CLOSED' state recovery join race condition
        if (!_roomChannel || this.currentRoomId !== signal.roomId || !this.roomSubscribed) {
            console.log(`[CallService] Joining room ${signal.roomId} for accepted call...`);
            await new Promise<void>((resolve) => {
                this.joinRoom(signal.roomId!, resolve);
            });
        } else {
            console.log(`[CallService] Already in room ${signal.roomId}, skipping rejoin.`);
        }

        // Ensure polling is active
        this.startSignalPolling();

        // Room is ready. Now send accept to caller's personal channel.
        await this.sendSignal({
            ...signal,
            type: 'call-accept',
            calleeId: this.userId!,
            calleeName: this.currentUser?.name || '',
            calleeAvatar: this.currentUser?.avatar || '',
            timestamp: new Date().toISOString(),
            signalId: Crypto.randomUUID() // Generate fresh signalId for the response
        });
    }

    // ── PUBLIC: rejectCall() ─────────────────────────────────────────────

    async rejectCall(signal: CallSignal): Promise<void> {
        if (!this.userId || !signal.roomId) return;

        console.log(`[CallService] Rejecting call from ${signal.callerId}`);

        // Clear timeout since call was rejected
        this.clearCallTimeout();

        await this.sendSignal({
            ...signal,
            type: 'call-reject',
            calleeId: this.userId,
            timestamp: new Date().toISOString(),
            signalId: Crypto.randomUUID()
        });

        this.cleanup('reject');
    }

    // ── PUBLIC: endCall() ────────────────────────────────────────────────

    async endCall(): Promise<void> {
        if (this.userId && this.currentRoomId) {
            console.log('[CallService] Ending call');
            await this.sendSignal({
                type: 'call-end',
                callId: this.currentRoomId,
                callerId: this.userId,
                calleeId: this.currentPartnerId || '',
                callType: this.currentCallType,
                timestamp: new Date().toISOString(),
                roomId: this.currentRoomId
            });
        }
        this.cleanup('manual-end');
    }

    // ── PUBLIC: notifyRinging() ──────────────────────────────────────────

    public async notifyRinging(roomId: string, callerId: string, callType: 'audio' | 'video'): Promise<void> {
        if (!this.userId) return;
        console.log(`[CallService] Notifying ringing for room ${roomId} to caller ${callerId}`);

        const sendRinging = async () => {
            await this.sendSignal({
                type: 'call-ringing',
                callId: roomId,
                callerId,
                calleeId: this.userId!,
                callType,
                timestamp: new Date().toISOString(),
                roomId
            });
        };

        // Ensure we are in the room first
        if (!_roomChannel || this.currentRoomId !== roomId || !this.roomSubscribed) {
            console.log(`[CallService] Joining room ${roomId} before notifying ringing...`);
            this.joinRoom(roomId, sendRinging);
        } else {
            sendRinging();
        }
    }

    // ── PRIVATE: sendToPersonalChannel() ─────────────────────────────────

    private async sendToPersonalChannel(recipientId: string, event: string, signal: CallSignal, signalType: string): Promise<void> {
        const channelName = `call_user_${recipientId}`;
        
        // Reuse channel if it exists in pool
        let targetChannel = _senderChannels.get(channelName);

        // Self-heal stale channels before using them
        if (targetChannel && ['closed', 'errored', 'leaving'].includes(targetChannel.state)) {
            _senderChannels.delete(channelName);
            try { supabase.removeChannel(targetChannel); } catch (_) {}
            targetChannel = undefined as any;
        }

        if (!targetChannel) {
            console.log(`[CallService] 🛰️ Creating new sender channel for ${recipientId}`);
            targetChannel = supabase.channel(channelName, {
                config: { broadcast: { self: false } },
            });
            _senderChannels.set(channelName, targetChannel);
        }

        return new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                console.warn(`[CallService] ⏳ Timeout sending ${signalType} to ${recipientId}`);
                resolve();
            }, 5000);

            const performSend = () => {
                if (!targetChannel) {
                    clearTimeout(timeout);
                    resolve();
                    return;
                }
                targetChannel.send({
                    type: 'broadcast',
                    event: event,
                    payload: signal,
                }).then(() => {
                    console.log(`[CallService] ✅ ${signalType} sent to ${recipientId}`);
                    clearTimeout(timeout);
                    resolve();
                }).catch((err) => {
                    console.warn(`[CallService] Failed to send ${signalType}:`, err);
                    clearTimeout(timeout);
                    resolve();
                });
            };

            if (targetChannel.state === 'joined') {
                performSend();
            } else if (targetChannel.state === 'joining') {
                // Avoid repeated subscribe() calls while channel is already joining.
                // Poll lightweight state until it is joined/failed or timeout fires.
                const waitForJoined = () => {
                    if (!targetChannel) {
                        clearTimeout(timeout);
                        resolve();
                        return;
                    }
                    if (targetChannel.state === 'joined') {
                        performSend();
                        return;
                    }
                    if (targetChannel.state === 'closed' || targetChannel.state === 'errored' || targetChannel.state === 'leaving') {
                        console.warn(`[CallService] Sender channel error for ${recipientId}: ${targetChannel.state.toUpperCase()}`);
                        _senderChannels.delete(channelName);
                        try { supabase.removeChannel(targetChannel); } catch (_) {}
                        clearTimeout(timeout);
                        resolve();
                        return;
                    }
                    setTimeout(waitForJoined, 120);
                };
                waitForJoined();
            } else {
                targetChannel.subscribe((status) => {
                    if (status === 'SUBSCRIBED') {
                        performSend();
                    } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED') {
                        console.warn(`[CallService] Sender channel error for ${recipientId}: ${status}`);
                        _senderChannels.delete(channelName);
                        try { supabase.removeChannel(targetChannel!); } catch (_) {}
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            }
        });
    }

    // ── SEND SIGNAL (Dual-path: DB primary + Broadcast bonus) ─────────────

    async sendSignal(signal: CallSignal) {
        if (!signal.signalId) {
            signal.signalId = Crypto.randomUUID();
        }

        const signalType = signal.type;
        
        // Normalize IDs
        if (signal.callerId) signal.callerId = normalizeId(signal.callerId);
        if (signal.calleeId) signal.calleeId = normalizeId(signal.calleeId);
        
        const recipientId = this.getRecipientId(signal);

        // ── 1. PRIMARY: Insert into DB (Lifecycle events ONLY) ─────────────
        // We prune transient WebRTC/UI signals to keep the DB small and fast.
        const shouldPersist = ['call-request', 'call-accept', 'call-reject', 'call-end'].includes(signalType);
        
        if (shouldPersist) {
            try {
                await supabase.from('call_signals').insert({
                    signal_id:   signal.signalId,
                    sender_id:   this.userId,
                    receiver_id: normalizeId(recipientId),
                    type:        signalType,
                    payload:     signal
                });
                console.log(`[CallService] ✅ Lifecycle Signal [${signalType}] persisted to DB`);
            } catch (dbErr) {
                console.warn('[CallService] ❌ DB signaling failed:', dbErr);
            }
        }

        // ── 2. SECONDARY: Broadcast path ───────────────────────────────────
        try {
            const normalizedRecipientId = normalizeId(recipientId);
            const isLifecycle = ['call-request', 'call-accept', 'call-reject', 'call-ringing'].includes(signalType);

            if (isLifecycle) {
                // Personal Broadcast Channel
                this.sendToPersonalChannel(normalizedRecipientId, 'call_signal', signal, signalType)
                    .catch(() => {});

                // Push notifications
                if (signalType === 'call-request') {
                    console.log(`[CallService] 🔔 Triggering call-push for ${normalizedRecipientId}`);
                    supabase.functions.invoke('send-call-push', {
                        body: {
                            calleeId: normalizedRecipientId,
                            callerId: this.userId,
                            callId: signal.callId,
                            callType: signal.callType,
                            callerName: this.currentUser?.name || 'Someone'
                        }
                    }).catch(pushErr => {
                        console.warn('[CallService] ⚠️ Call push trigger failed:', pushErr.message);
                    });
                }
            } else {
                // Room Broadcast (SDP, ICE, Track Toggles)
                if (_roomChannel && this.roomSubscribed) {
                    _roomChannel.send({
                        type: 'broadcast',
                        event: 'signal',
                        payload: signal,
                    }).catch(e => {
                        console.warn(`[CallService] ❌ Failed to broadcast room signal [${signalType}]:`, e);
                    });
                } else if (signal.roomId || this.currentRoomId) {
                    // BUFFERING: If room isn't ready yet, queue the signal
                    // We only buffer room signals, not lifecycle signals (which have DB fallback)
                    if (this.signalBuffer.length < 50) {
                        console.log(`[CallService] 📦 Buffering room signal [${signalType}] (Room not ready)`);
                        this.signalBuffer.push(signal);
                    }
                }
            }
        } catch (_) {}
    }

    private getRecipientId(signal: CallSignal): string {
        if (signal.type === 'call-request') return signal.calleeId;
        const myId = normalizeId(this.userId || '');
        const callerId = normalizeId(signal.callerId);
        if (myId === callerId) return signal.calleeId;
        return signal.callerId;
    }

    // ── WebRTC signal helpers ────────────────────────────────────────────

    async sendOffer(offer: any): Promise<void> {
        if (this.currentRoomId) {
            await this.sendSignal({
                type: 'offer',
                callId: this.currentRoomId,
                callerId: this.userId || '',
                calleeId: this.currentPartnerId || '',
                callType: this.currentCallType,
                payload: offer,
                timestamp: new Date().toISOString(),
                roomId: this.currentRoomId
            });
        }
    }

    async sendAnswer(answer: any): Promise<void> {
        if (this.currentRoomId) {
            await this.sendSignal({
                type: 'answer',
                callId: this.currentRoomId,
                callerId: this.userId || '',
                calleeId: this.currentPartnerId || '',
                callType: this.currentCallType,
                payload: answer,
                timestamp: new Date().toISOString(),
                roomId: this.currentRoomId
            });
        }
    }

    async sendIceCandidate(candidate: any): Promise<void> {
        if (this.currentRoomId) {
            await this.sendSignal({
                type: 'ice-candidate',
                callId: this.currentRoomId,
                callerId: this.userId || '',
                calleeId: this.currentPartnerId || '',
                callType: this.currentCallType,
                payload: candidate ? (candidate.toJSON ? candidate.toJSON() : candidate) : null,
                timestamp: new Date().toISOString(),
                roomId: this.currentRoomId
            });
        }
    }

    // ── Listener management ─────────────────────────────────────────────

    private notifyListeners(signal: CallSignal) {
        this.listeners.forEach(listener => listener(signal));
    }

    addListener(handler: CallSignalHandler): void {
        this.listeners.add(handler);
    }

    removeListener(handler: CallSignalHandler): void {
        this.listeners.delete(handler);
    }

    private async checkRealtimeReachable(): Promise<boolean> {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            return !!session;
        } catch {
            return false;
        }
    }

    // ── PUBLIC: cleanup() ───────────────────────────────────────────────

    cleanup(reason: string = 'unknown'): void {
        console.log(`[CallService] 🧹 Cleaning up call state. Reason: ${reason}`);
        
        const roomId = this.currentRoomId;

        // CRITICAL: Set state to null BEFORE closing channels
        this.currentRoomId = null;
        this.currentPartnerId = null;
        this.roomSubscribed = false;
        this.roomSubscribeCallbacks = [];
        this.currentCallType = 'audio';

        // Clear timeouts
        this.clearCallTimeout();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (_roomChannel) {
            console.log(`[CallService] Unsubscribing from room ${roomId}`);
            try { supabase.removeChannel(_roomChannel); } catch (_) {}
            _roomChannel = null;
        }

        if (this.signalPollInterval) {
            clearInterval(this.signalPollInterval);
            this.signalPollInterval = null;
        }
        
        if (this._fastPollInterval) {
            clearInterval(this._fastPollInterval);
            this._fastPollInterval = null;
        }

        this.signalBuffer = [];

        if (_signalSubscription) {
            try { supabase.removeChannel(_signalSubscription); } catch (_) {}
            _signalSubscription = null;
        }

        // Cleanup pool
        console.log(`[CallService] 🧹 Cleaning up ${_senderChannels.size} sender channels`);
        _senderChannels.forEach((ch, name) => {
            try { supabase.removeChannel(ch); } catch (_) {}
        });
        _senderChannels.clear();

        // Clear processed signal IDs
        this.processedSignalIds.clear();
        
        // Clear persisted state
        this.clearPersistedCallState();
    }

    private async persistCallState(): Promise<void> {
        try {
            const AsyncStorage = require('@react-native-async-storage/async-storage').default;
            const state = {
                roomId: this.currentRoomId,
                partnerId: this.currentPartnerId,
                callType: this.currentCallType,
                persistedAt: new Date().toISOString(),
            };
            await AsyncStorage.setItem('soulsync_active_call', JSON.stringify(state));
        } catch (error) {
            console.warn('[CallService] Failed to persist call state:', error);
        }
    }

    private async clearPersistedCallState(): Promise<void> {
        try {
            const AsyncStorage = require('@react-native-async-storage/async-storage').default;
            await AsyncStorage.removeItem('soulsync_active_call');
        } catch (error) {
            console.warn('[CallService] Failed to clear persisted call state:', error);
        }
    }

    async checkAndRecoverCall(): Promise<{ roomId: string; partnerId: string; callType: 'audio' | 'video' } | null> {
        try {
            const AsyncStorage = require('@react-native-async-storage/async-storage').default;
            const stateStr = await AsyncStorage.getItem('soulsync_active_call');
            if (!stateStr) return null;

            const state = JSON.parse(stateStr);
            const persistedAt = new Date(state.persistedAt).getTime();
            const now = Date.now();

            if (now - persistedAt < 5 * 60 * 1000) {
                console.log('[CallService] Found persisted call state, attempting recovery:', state);
                return state;
            } else {
                await this.clearPersistedCallState();
                return null;
            }
        } catch (error) {
            console.warn('[CallService] Failed to check call recovery:', error);
            return null;
        }
    }
}

export const callService = new CallService();
