import { supabase } from '../config/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';

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
}

type CallSignalHandler = (signal: CallSignal) => void;

class CallService {
    private personalChannel: RealtimeChannel | null = null;
    private roomChannel: RealtimeChannel | null = null;
    private userId: string | null = null;
    private listeners: Set<CallSignalHandler> = new Set();
    private statusListeners: Set<(connected: boolean) => void> = new Set();
    private currentRoomId: string | null = null;
    private currentPartnerId: string | null = null;
    private currentCallType: 'audio' | 'video' = 'audio';
    private roomSubscribed: boolean = false;
    private isJoiningRoom: boolean = false;
    private roomSubscribeCallbacks: (() => void)[] = [];
    // FIX #5: Add call timeout tracking
    private callTimeoutTimer: NodeJS.Timeout | null = null;
    private readonly CALL_TIMEOUT_MS = 45000; // 45 seconds timeout
    private reconnectAttempts: number = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private personalChannelSubscribed: boolean = false;
    private processedSignalIds: Set<string> = new Set();
    private signalPollTimer: NodeJS.Timeout | null = null;
    private lastSignalPollAt: string = new Date().toISOString();

    addStatusListener(handler: (connected: boolean) => void): void {
        this.statusListeners.add(handler);
        handler(this.personalChannel !== null);
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
    initialize(userId: string): void {
        // If same user AND channel is alive and subscribed, skip
        if (this.userId === userId && this.personalChannel && this.personalChannelSubscribed) {
            console.log('[CallService] Already initialized and SUBSCRIBED for', userId);
            return;
        }

        // If channel exists but is NOT subscribed (dead after CLOSED), tear it down
        if (this.personalChannel) {
            console.log('[CallService] Tearing down stale personal channel before re-init');
            this.personalChannel.unsubscribe();
            supabase.removeChannel(this.personalChannel);
            this.personalChannel = null;
            this.personalChannelSubscribed = false;
        }

        // Clear any pending reconnect
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.userId = userId;
        this.reconnectAttempts = 0;
        this.processedSignalIds.clear();
        this.lastSignalPollAt = new Date().toISOString();
        this._subscribePersonalChannel(userId);
        this.startSignalPolling();
    }

    private startSignalPolling() {
        if (this.signalPollTimer) clearInterval(this.signalPollTimer);
        this.signalPollTimer = setInterval(() => this.pollForSignals(), 3000); 
    }

    private async pollForSignals() {
        if (!this.userId) return;
        try {
            const { data, error } = await supabase
                .from('call_signals')
                .select('*')
                .eq('receiver_id', this.userId)
                .gt('created_at', this.lastSignalPollAt)
                .order('created_at', { ascending: true });

            if (error) throw error;

            if (data && data.length > 0) {
                this.lastSignalPollAt = data[data.length - 1].created_at;
                data.forEach(row => {
                    // Reconstruct CallSignal from DB row
                    const signal: CallSignal = {
                        ...(row.payload as any),
                        type: row.type as any,
                        signalId: row.signal_id,
                        callerId: row.sender_id,
                        calleeId: row.receiver_id,
                        timestamp: row.created_at
                    };
                    this.handleIncomingSignal(signal);
                });
            }
        } catch (err) {
            // Non-fatal, just log it
            console.log('[CallService] Signal polling check:', err);
        }
    }

    private _subscribePersonalChannel(userId: string): void {
        const channelName = `call_user_${userId}`;
        console.log(`[CallService] Initializing Supabase Realtime signaling on channel: ${channelName}`);

        this.personalChannel = supabase.channel(channelName, {
            config: { broadcast: { self: false } },
        });

        // Listen for all call signal types on the personal channel
        this.personalChannel.on('broadcast', { event: 'call_signal' }, ({ payload }) => {
            const signal = payload as CallSignal;
            console.log(`📞 [CallService] Received signal [${signal.type}] from ${signal.callerId}`);
            this.handleIncomingSignal(signal);
        });

        // Per-subscription guard — prevents Supabase from firing CLOSED multiple times
        // on the same channel object when the WebSocket drops (which causes the spam).
        let closedHandled = false;

        this.personalChannel.subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
                this.reconnectAttempts = 0;
                this.personalChannelSubscribed = true;
                closedHandled = false;
                this.notifyStatus(true);
                console.log(`[CallService] ✅ Personal channel SUBSCRIBED for ${userId}`);
            } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                if (closedHandled) return;
                closedHandled = true;

                this.personalChannelSubscribed = false;
                this.notifyStatus(false);
                
                if (this.reconnectTimer) return;
                
                // Exponential backoff: 1s, 2s, 4s, 8s, 16s, then cap at 30s
                // No max attempts — channel must self-heal for incoming calls
                const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
                this.reconnectAttempts++;
                
                console.warn(`[CallService] ⚠️ Personal channel ${status} for ${userId}. Retry in ${delay}ms (attempt #${this.reconnectAttempts})`);
                
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    
                    if (this.userId === userId) {
                        if (this.personalChannel) {
                            supabase.removeChannel(this.personalChannel);
                            this.personalChannel = null;
                        }
                        this._subscribePersonalChannel(userId);
                    }
                }, delay);
            }
        });
    }

    private handleIncomingSignal(signal: CallSignal) {
        // Cross-path deduplication: check if we've already processed this signal
        // This prevents double-processing when signal arrives via both Broadcast AND DB poll
        if (signal.signalId) {
            if (this.processedSignalIds.has(signal.signalId)) {
                console.log(`[CallService] 🔁 Skipping duplicate signal [${signal.type}] id: ${signal.signalId}`);
                return;
            }
            this.processedSignalIds.add(signal.signalId);
        }

        // If it's a call request and we are already in a call, check if it's the SAME call
        if (signal.type === 'call-request' && this.currentRoomId) {
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

    // ── Room channel (for WebRTC signals after call-accept) ────────────────

    private setupRoomListeners(channel: RealtimeChannel, _roomId: string): void {
        channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
            const signal = payload as CallSignal;
            console.log(`[CallService] Received room signal [${signal.type}]`);
            this.notifyListeners(signal);

            if (signal.type === 'call-end' || signal.type === 'call-reject') {
                this.cleanup();
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

        const isChannelValid = this.roomChannel && this.currentRoomId === roomId;

        if (isChannelValid && this.roomSubscribed) {
            console.log(`[CallService] Already joined room ${roomId}. Reusing connection.`);
            if (onSubscribed) {
                onSubscribed();
            }
            return;
        }

        // Clean up previous room channel completely
        if (this.roomChannel) {
            console.log(`[CallService] Cleaning up old room channel: ${this.currentRoomId}`);
            this.roomChannel.unsubscribe();
            supabase.removeChannel(this.roomChannel);
            this.roomChannel = null;
        }

        console.log(`[CallService] Joining room ${roomId}...`);
        this.currentRoomId = roomId;
        this.roomSubscribed = false;
        this.isJoiningRoom = true;
        this.roomSubscribeCallbacks = [];

        if (onSubscribed) {
            this.roomSubscribeCallbacks.push(onSubscribed);
        }

        this.roomChannel = supabase.channel(`call_room_${roomId}`, {
            config: { broadcast: { self: false } },
        });

        this.setupRoomListeners(this.roomChannel, roomId);

        const timeout = setTimeout(() => {
            console.warn(`[CallService] Room ${roomId} subscription timeout - proceeding anyway`);
            this.handleJoinSuccess(roomId);
        }, 10000);

        this.roomChannel.subscribe((status) => {
            console.log(`[CallService] Room ${roomId} subscription status: ${status}`);
            
            if (status === 'SUBSCRIBED') {
                clearTimeout(timeout);
                this.handleJoinSuccess(roomId);
            } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED') {
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
            }
        });
    }

    private handleJoinSuccess(roomId: string) {
        if (this.roomSubscribed && this.currentRoomId === roomId) return;
        
        this.roomSubscribed = true;
        this.isJoiningRoom = false;
        const callbacks = [...this.roomSubscribeCallbacks];
        this.roomSubscribeCallbacks = [];
        console.log(`[CallService] Room ${roomId} joined successfully. Notifying ${callbacks.length} listeners.`);
        callbacks.forEach(cb => cb());
    }

    // FIX #5: Add call timeout methods
    private startCallTimeout(onTimeout: () => void): void {
        this.clearCallTimeout();
        this.callTimeoutTimer = setTimeout(() => {
            console.warn('[CallService] ⚠️ Call timeout reached - no response from callee');
            onTimeout();
        }, this.CALL_TIMEOUT_MS);
    }

    private clearCallTimeout(): void {
        if (this.callTimeoutTimer) {
            clearTimeout(this.callTimeoutTimer);
            this.callTimeoutTimer = null;
        }
    }

    // ── PUBLIC: initiateCall() ────────────────────────────────────────────

    async startCall(partnerId: string, callType: 'audio' | 'video'): Promise<string | null> {
        if (!this.userId) return null;

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

        // FIX #12: Persist call state for crash recovery
        this.persistCallState();

        console.log(`[CallService] Initiating Supabase call to ${partnerId} in room ${roomId}`);

        const signal: CallSignal = {
            type: 'call-request',
            callId: roomId,
            callerId: this.userId!,
            calleeId: partnerId,
            callType,
            roomId,
            timestamp: new Date().toISOString()
        };

        // Join the room first so we're ready for the answer
        this.joinRoom(roomId);

        // Send call-request to the callee's personal channel
        await this.sendSignal(signal);
        console.log('[CallService] 📤 Call request sent via Supabase Broadcast');

        // FIX #5: Start timeout - if no response in 45 seconds, end the call
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

        // FIX #5: Clear timeout since call was accepted
        this.clearCallTimeout();

        // Join room and wait until subscribed BEFORE sending accept.
        // This ensures we are already listening on the room channel by the time
        // the caller receives call-accept and fires the WebRTC offer — so we
        // never miss the offer signal.
        await new Promise<void>((resolve) => {
            this.joinRoom(signal.roomId!, resolve);
        });

        // Room is ready. Now send accept to caller's personal channel.
        await this.sendSignal({
            ...signal,
            type: 'call-accept',
            calleeId: this.userId!,
            timestamp: new Date().toISOString(),
            signalId: Crypto.randomUUID() // FIX: Generate fresh signalId for the response
        });
    }

    // ── PUBLIC: rejectCall() ─────────────────────────────────────────────

    async rejectCall(signal: CallSignal): Promise<void> {
        if (!this.userId || !signal.roomId) return;

        console.log(`[CallService] Rejecting call from ${signal.callerId}`);

        // FIX #5: Clear timeout since call was rejected
        this.clearCallTimeout();

        await this.sendSignal({
            ...signal,
            type: 'call-reject',
            calleeId: this.userId,
            timestamp: new Date().toISOString(),
            signalId: Crypto.randomUUID() // FIX: Generate fresh signalId for the response
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
        if (!this.roomChannel || this.currentRoomId !== roomId || !this.roomSubscribed) {
            this.joinRoom(roomId, sendRinging);
        } else {
            await sendRinging();
        }
    }

    // ── PRIVATE: sendToPersonalChannel() ─────────────────────────────────
    //
    // Creates a temporary channel to broadcast a signal to a specific user's
    // personal channel. Properly awaits until the signal is actually sent.
    private sendToPersonalChannel(recipientId: string, event: string, signal: CallSignal, signalType: string): Promise<void> {
        return new Promise<void>((resolve) => {
            const channelName = `call_user_${recipientId}`;
            console.log(`[CallService] 🛰️ Sending ${signalType} to ${channelName}...`);

            // NOTE: If this device already has a channel with this name (e.g. own personal channel),
            // Supabase client will return the EXISTING channel. We handle this by removing it first
            // only if it's a DIFFERENT user's personal channel (we never send to our own).
            const targetChannel = supabase.channel(channelName, {
                config: { broadcast: { self: false } },
            });

            const timer = setTimeout(() => {
                console.warn(`[CallService] ⚠️ Send timeout for ${signalType} to ${recipientId}`);
                try { 
                    targetChannel.unsubscribe(); 
                    supabase.removeChannel(targetChannel);
                } catch (_) {}
                resolve(); // best-effort
            }, 10000);

            targetChannel.subscribe((status, err) => {
                if (status === 'SUBSCRIBED') {
                    console.log(`[CallService] 🚀 Channel ${channelName} SUBSCRIBED. Broadcasting...`);
                    targetChannel.send({
                        type: 'broadcast',
                        event,
                        payload: signal,
                    }).then((resp) => {
                        clearTimeout(timer);
                        console.log(`[CallService] ✅ Sent ${signalType} to ${channelName}. Response:`, resp);
                        // Clean up after a short delay to ensure broadcast is flushed
                        setTimeout(() => { 
                            try { 
                                targetChannel.unsubscribe(); 
                                supabase.removeChannel(targetChannel);
                            } catch (_) {} 
                        }, 1000);
                        resolve();
                    }).catch((err) => {
                        clearTimeout(timer);
                        console.warn(`[CallService] ❌ Failed to broadcast ${signalType} to ${recipientId}:`, err);
                        try { 
                            targetChannel.unsubscribe(); 
                            supabase.removeChannel(targetChannel);
                        } catch (_) {}
                        resolve(); // best-effort
                    });
                } else if (status === 'CHANNEL_ERROR') {
                    // ❌ Actual error — warn about it
                    clearTimeout(timer);
                    console.warn(`[CallService] ❌ Channel ERROR for ${recipientId}:`, err?.message || 'No error details');
                    try { 
                        targetChannel.unsubscribe(); 
                        supabase.removeChannel(targetChannel);
                    } catch (_) {}
                    resolve();
                } else if (status === 'CLOSED') {
                    // ✅ CLOSED is EXPECTED — intentional cleanup after send, no warn needed
                    clearTimeout(timer);
                    try { 
                        supabase.removeChannel(targetChannel);
                    } catch (_) {}
                    resolve();
                }
            });
        });
    }

    // ── SEND SIGNAL (Dual-path: DB primary + Broadcast bonus) ─────────────
    //
    // DB INSERT is the PRIMARY transport — goes through HTTP proxy, always works.
    // Broadcast is a BONUS — faster but requires WebSocket (blocked by some ISPs).
    async sendSignal(signal: CallSignal) {
        // Generate unique signalId for cross-path deduplication (prevents double-processing)
        if (!signal.signalId) {
            signal.signalId = Crypto.randomUUID();
        }

        const signalType = signal.type;
        const recipientId = this.getRecipientId(signal);

        // 1. PRIMARY: Insert into DB (works through proxies, firewall friendly)
        try {
            await supabase.from('call_signals').insert({
                signal_id: signal.signalId,
                sender_id: this.userId,
                receiver_id: recipientId,
                type: signalType,
                payload: signal
            });
            console.log(`[CallService] ✅ Signal [${signalType}] persisted to DB`);
        } catch (dbErr) {
            console.warn('[CallService] ❌ DB signaling failed:', dbErr);
            // Continue to Broadcast anyway as fallback-of-fallback
        }

        // 2. BONUS: Also try broadcast (faster if WebSocket works)
        try {
            if (signalType === 'call-request' || signalType === 'call-accept' || 
                signalType === 'call-reject' || signalType === 'call-ringing') {
                // Personal channel signals
                this.sendToPersonalChannel(recipientId, 'call_signal', signal, signalType)
                    .catch(() => {}); // best-effort, don't await
            } else if (this.roomChannel && this.roomSubscribed) {
                // Room signals (offer, answer, ice-candidate, etc.)
                this.roomChannel.send({
                    type: 'broadcast',
                    event: 'signal',
                    payload: signal,
                }).catch(() => {});
            }
        } catch (_) {
            // Broadcast failed — DB already sent or triggered, so we're fine
        }
    }

    private getRecipientId(signal: CallSignal): string {
        if (signal.type === 'call-request') return signal.calleeId;
        if (this.userId === signal.callerId) return signal.calleeId;
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
                payload: candidate.toJSON ? candidate.toJSON() : candidate,
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

    // ── PUBLIC: cleanup() ───────────────────────────────────────────────

    cleanup(reason: string = 'unknown'): void {
        console.log(`[CallService] 🧹 Cleaning up call state. Reason: ${reason}`);
        
        // Save these for logging before we null them
        const roomId = this.currentRoomId;

        // CRITICAL: Set state to null BEFORE closing channels
        // This prevents the subscribe callback from seeing 'currentRoomId === roomId'
        // and attempting a recovery re-join.
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

        if (this.roomChannel) {
            console.log(`[CallService] Unsubscribing from room ${roomId}`);
            this.roomChannel.unsubscribe();
            supabase.removeChannel(this.roomChannel);
            this.roomChannel = null;
        }

        if (this.signalPollTimer) {
            clearInterval(this.signalPollTimer);
            this.signalPollTimer = null;
        }
        
        // Clear persisted state
        this.clearPersistedCallState();
    }

    // FIX #12: Persist call state for crash recovery
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

    // FIX #12: Check for and recover from crashed call state
    async checkAndRecoverCall(): Promise<{ roomId: string; partnerId: string; callType: 'audio' | 'video' } | null> {
        try {
            const AsyncStorage = require('@react-native-async-storage/async-storage').default;
            const stateStr = await AsyncStorage.getItem('soulsync_active_call');
            if (!stateStr) return null;

            const state = JSON.parse(stateStr);
            // Check if persisted within last 5 minutes (crash recovery window)
            const persistedAt = new Date(state.persistedAt).getTime();
            const now = Date.now();

            if (now - persistedAt < 5 * 60 * 1000) {
                console.log('[CallService] Found persisted call state, attempting recovery:', state);
                return state;
            } else {
                // State too old, clear it
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
