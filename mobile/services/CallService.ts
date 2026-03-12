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
    private roomSubscribeCallbacks: (() => void)[] = [];
    // FIX #5: Add call timeout tracking
    private callTimeoutTimer: NodeJS.Timeout | null = null;
    private readonly CALL_TIMEOUT_MS = 45000; // 45 seconds timeout

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
        if (this.userId === userId && this.personalChannel) {
            console.log('[CallService] Already initialized for', userId);
            return;
        }

        // Cleanup previous if switching users
        if (this.personalChannel) {
            this.personalChannel.unsubscribe();
            this.personalChannel = null;
        }

        this.userId = userId;
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

        this.personalChannel.subscribe((status) => {
            console.log(`[CallService] Personal channel status: ${status}`);
            if (status === 'SUBSCRIBED') {
                this.notifyStatus(true);
            } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                this.notifyStatus(false);
            }
        });
    }

    private handleIncomingSignal(signal: CallSignal) {
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
        // FIX #11: Check if room channel is still valid and connected
        const isChannelValid = this.roomChannel && this.currentRoomId === roomId;

        if (isChannelValid && this.roomSubscribed) {
            console.log(`[CallService] Already joined room ${roomId}. Reusing connection.`);
            if (onSubscribed) {
                onSubscribed();
            }
            return;
        }

        // FIX #11: Force reconnect if channel exists but not subscribed (network loss)
        if (this.roomChannel && this.currentRoomId === roomId && !this.roomSubscribed) {
            console.log(`[CallService] Room ${roomId} exists but not subscribed. Reconnecting...`);
            this.roomChannel.unsubscribe();
        } else if (this.roomChannel) {
            this.roomChannel.unsubscribe();
        }

        this.currentRoomId = roomId;
        this.roomSubscribed = false;
        this.roomSubscribeCallbacks = [];

        if (onSubscribed) {
            this.roomSubscribeCallbacks.push(onSubscribed);
        }

        this.roomChannel = supabase.channel(`call_room_${roomId}`, {
            config: { broadcast: { self: false } },
        });

        this.setupRoomListeners(this.roomChannel, roomId);

        this.roomChannel.subscribe((status) => {
            console.log(`[CallService] Room ${roomId} subscription status: ${status}`);
            if (status === 'SUBSCRIBED') {
                this.roomSubscribed = true;
                const callbacks = [...this.roomSubscribeCallbacks];
                this.roomSubscribeCallbacks = [];
                callbacks.forEach(cb => cb());
            } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED') {
                // FIX #11: Attempt reconnection on error
                console.warn(`[CallService] Room ${roomId} error: ${status}. Will retry...`);
                setTimeout(() => {
                    if (!this.roomSubscribed && this.currentRoomId === roomId) {
                        this.joinRoom(roomId);
                    }
                }, 2000);
            }
        });
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

    async initiateCall(partnerId: string, callType: 'audio' | 'video'): Promise<string | null> {
        if (!this.userId) return null;

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
            timestamp: new Date().toISOString()
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
            timestamp: new Date().toISOString()
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
            const targetChannel = supabase.channel(`call_user_${recipientId}`, {
                config: { broadcast: { self: false } },
            });

            const timer = setTimeout(() => {
                console.warn(`[CallService] ⚠️ Send timeout for ${signalType} to ${recipientId}`);
                try { targetChannel.unsubscribe(); } catch (_) {}
                resolve(); // best-effort — don't reject, caller should handle gracefully
            }, 8000);

            targetChannel.subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    targetChannel.send({
                        type: 'broadcast',
                        event,
                        payload: signal,
                    }).then(() => {
                        clearTimeout(timer);
                        console.log(`[CallService] ✅ Sent ${signalType} to call_user_${recipientId}`);
                        setTimeout(() => { try { targetChannel.unsubscribe(); } catch (_) {} }, 500);
                        resolve();
                    }).catch((err) => {
                        clearTimeout(timer);
                        console.warn(`[CallService] ❌ Failed to send ${signalType}:`, err);
                        setTimeout(() => { try { targetChannel.unsubscribe(); } catch (_) {} }, 500);
                        resolve(); // best-effort
                    });
                } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED') {
                    clearTimeout(timer);
                    console.warn(`[CallService] ❌ Channel error for ${signalType}: ${status}`);
                    resolve(); // best-effort
                }
            });
        });
    }

    // ── PRIVATE: sendSignal() ────────────────────────────────────────────
    //
    // Routes signals to the correct channel:
    //   - call-request → callee's personal channel (so it reaches them even if not in a room)
    //   - call-accept/reject → caller's personal channel
    //   - offer/answer/ice-candidate/call-end → room channel (both users are subscribed)
    //   - call-ringing → caller's personal channel
    async sendSignal(signal: CallSignal) {
        const signalType = signal.type;

        // Determine which channel to broadcast on
        if (signalType === 'call-request') {
            // Send to callee's personal channel — properly awaited
            await this.sendToPersonalChannel(signal.calleeId, 'call_signal', signal, signalType);
        } else if (signalType === 'call-accept' || signalType === 'call-reject' || signalType === 'call-ringing') {
            // Send to the caller's personal channel — properly awaited
            const recipientId = (this.userId === signal.callerId) ? signal.calleeId : signal.callerId;
            await this.sendToPersonalChannel(recipientId, 'call_signal', signal, signalType);
        } else {
            // offer, answer, ice-candidate, call-end, video-toggle, audio-toggle
            // → send via room channel (both users are subscribed to it)
            if (this.roomChannel && this.roomSubscribed) {
                await this.roomChannel.send({
                    type: 'broadcast',
                    event: 'signal',
                    payload: signal,
                });
                console.log(`[CallService] ✅ Sent ${signalType} via room channel`);
            } else if (this.currentRoomId) {
                // Room not yet subscribed — join and queue
                this.joinRoom(this.currentRoomId, async () => {
                    await this.roomChannel?.send({
                        type: 'broadcast',
                        event: 'signal',
                        payload: signal,
                    });
                    console.log(`[CallService] ✅ Sent queued ${signalType} via room channel`);
                });
            } else {
                console.warn(`[CallService] ❌ Cannot send ${signalType}: No room channel`);
            }
        }
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
        // FIX #5: Clear call timeout
        this.clearCallTimeout();

        if (this.roomChannel) {
            console.log(`[CallService] Unsubscribing from room ${this.currentRoomId}`);
            this.roomChannel.unsubscribe();
            this.roomChannel = null;
        }
        // NOTE: We do NOT unsubscribe from personalChannel here —
        // it stays alive so we can receive new calls.
        this.currentRoomId = null;
        this.currentPartnerId = null;
        this.roomSubscribed = false;
        this.roomSubscribeCallbacks = [];
        this.currentCallType = 'audio';

        // FIX #12: Clear persisted call state on cleanup
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
