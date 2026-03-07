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

    private setupRoomListeners(channel: RealtimeChannel, roomId: string): void {
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
        if (this.roomChannel && this.currentRoomId === roomId) {
            console.log(`[CallService] Already joined or joining room ${roomId}. Reusing connection.`);
            if (onSubscribed) {
                if (this.roomSubscribed) {
                    onSubscribed();
                } else {
                    this.roomSubscribeCallbacks.push(onSubscribed);
                }
            }
            return;
        }

        if (this.roomChannel) {
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
            }
        });
    }

    // ── PUBLIC: initiateCall() ────────────────────────────────────────────

    async initiateCall(partnerId: string, callType: 'audio' | 'video'): Promise<string | null> {
        if (!this.userId) return null;

        const roomId = Crypto.randomUUID();
        this.currentRoomId = roomId;
        this.currentPartnerId = partnerId;
        this.currentCallType = callType;

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

        return roomId;
    }

    // ── PUBLIC: acceptCall() ─────────────────────────────────────────────

    async acceptCall(signal: CallSignal): Promise<void> {
        if (!this.userId || !signal.roomId) return;

        console.log(`[CallService] Accepting call from ${signal.callerId} (Supabase)`);
        this.currentRoomId = signal.roomId;
        this.currentPartnerId = signal.callerId;
        this.currentCallType = signal.callType;

        // Join the room for WebRTC signaling
        this.joinRoom(signal.roomId);

        // Send accept to the caller's personal channel
        await this.sendSignal({
            ...signal,
            type: 'call-accept',
            calleeId: this.userId,
            timestamp: new Date().toISOString()
        });
    }

    // ── PUBLIC: rejectCall() ─────────────────────────────────────────────

    async rejectCall(signal: CallSignal): Promise<void> {
        if (!this.userId || !signal.roomId) return;

        console.log(`[CallService] Rejecting call from ${signal.callerId}`);
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
            // Send to callee's personal channel
            const targetChannel = supabase.channel(`call_user_${signal.calleeId}`);
            await targetChannel.subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    targetChannel.send({
                        type: 'broadcast',
                        event: 'call_signal',
                        payload: signal,
                    }).then(() => {
                        console.log(`[CallService] ✅ Sent ${signalType} to call_user_${signal.calleeId}`);
                        // Unsubscribe from target after sending — we only needed it to broadcast
                        setTimeout(() => targetChannel.unsubscribe(), 1000);
                    });
                }
            });
        } else if (signalType === 'call-accept' || signalType === 'call-reject' || signalType === 'call-ringing') {
            // Send to the caller's personal channel
            const recipientId = (this.userId === signal.callerId) ? signal.calleeId : signal.callerId;
            const targetChannel = supabase.channel(`call_user_${recipientId}`);
            await targetChannel.subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    targetChannel.send({
                        type: 'broadcast',
                        event: 'call_signal',
                        payload: signal,
                    }).then(() => {
                        console.log(`[CallService] ✅ Sent ${signalType} to call_user_${recipientId}`);
                        setTimeout(() => targetChannel.unsubscribe(), 1000);
                    });
                }
            });
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
                callType: 'audio',
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
    }
}

export const callService = new CallService();
