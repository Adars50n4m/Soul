import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react';
import { supabase } from '../config/supabase';
import { callService, CallSignal } from '../services/CallService';
// Safe import — WebRTC not available in Expo Go
let webRTCService: any = null;
try { webRTCService = require('../services/WebRTCService').webRTCService; } catch (_) {}
import { nativeCallBridge } from '../services/NativeCallBridge';
import { useAuth } from './AuthContext';
import { ActiveCall, CallLog } from '../types';
import { callDbService } from '../services/CallDBService';
import { normalizeId, getSuperuserName } from '../utils/idNormalization';

interface CallContextType {
    activeCall: ActiveCall | null;
    calls: CallLog[];
    startCall: (contactId: string, type: 'audio' | 'video') => Promise<void>;
    acceptCall: () => Promise<void>;
    endCall: () => Promise<void>;
    toggleMinimizeCall: (val: boolean) => void;
    toggleMute: () => void;
    toggleVideo: () => void;
    deleteCall: (id: string) => Promise<void>;
    clearCalls: () => Promise<void>;
}

export const CallContext = createContext<CallContextType | undefined>(undefined);

export const CallProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { currentUser } = useAuth();
    const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
    const [calls, setCalls] = useState<CallLog[]>([]);
    const activeCallRef = useRef(activeCall);
    const callStartTimeRef = useRef<number | null>(null);
    const incomingSignalRef = useRef<CallSignal | null>(null);

    useEffect(() => { activeCallRef.current = activeCall; }, [activeCall]);

    const fetchCalls = useCallback(async () => {
        if (!currentUser) return;

        // 1. Load from local SQLite first
        const localLogs = await callDbService.getCallLogs();
        if (localLogs.length > 0) {
            setCalls(localLogs);
        }

        // 2. Fetch from Supabase as secondary
        try {
            const { data, error } = await supabase
                .from('call_logs')
                .select('*')
                .or(`caller_id.eq.${currentUser.id},callee_id.eq.${currentUser.id}`)
                .order('created_at', { ascending: false })
                .limit(50);

            if (!error && data) {
                const mappedLogs: CallLog[] = data.map(log => ({
                    id: log.id,
                    contactId: log.caller_id === currentUser.id ? log.callee_id : log.caller_id,
                    contactName: getSuperuserName(log.caller_id === currentUser.id ? log.callee_id : log.caller_id) || 'User',
                    avatar: '',
                    time: log.created_at,
                    type: log.caller_id === currentUser.id ? 'outgoing' : 'incoming',
                    status: log.status || 'completed',
                    callType: log.call_type || 'audio',
                    duration: log.duration
                }));

                for (const log of mappedLogs) {
                    await callDbService.saveCallLog(log);
                }

                const finalLogs = await callDbService.getCallLogs();
                setCalls(finalLogs);
            }
        } catch (err) {
            console.warn('[CallContext] Supabase fetch failed:', err);
        }
    }, [currentUser]);

    useEffect(() => {
        if (!currentUser) return;

        callService.initialize(currentUser.id);

        nativeCallBridge.initialize(currentUser.id, {
            onCallAnswered: () => acceptCall(),
            onCallDeclined: () => endCall(),
            onCallConnected: () => {},
            onCallEnded: () => endCall(),
            onMuteToggled: (muted) => setActiveCall(prev => prev ? { ...prev, isMuted: muted } : null)
        }).catch(err => console.warn('[CallContext] NativeCallBridge init failed:', err));

        const signalHandler = async (signal: CallSignal) => {
            console.log(`[CallContext] Received signal: ${signal.type}`);
            
            switch (signal.type) {
                case 'call-request': {
                    if (signal.callerId === currentUser.id || activeCallRef.current) return;
                    
                    incomingSignalRef.current = signal;
                    const contactName = getSuperuserName(signal.callerId) || 'User';
                    setActiveCall({
                        callId: signal.callId,
                        contactId: signal.callerId,
                        contactName: contactName,
                        type: signal.callType,
                        isIncoming: true,
                        isAccepted: false,
                        isMuted: false,
                        isVideoOff: false,
                        isMinimized: false,
                        remoteVideoOff: false,
                        roomId: signal.roomId
                    });
                    
                    callService.notifyRinging(signal.roomId!, signal.callerId, signal.callType)
                        .catch(err => console.warn('[CallContext] Ringing signal failed:', err));
                    break;
                }
                case 'call-accept': {
                    setActiveCall(prev => prev ? { ...prev, isAccepted: true } : null);
                    callStartTimeRef.current = Date.now();
                    if (webRTCService && !activeCallRef.current?.isIncoming) {
                        try { webRTCService.onCallAccepted(); } catch (e) {}
                    }
                    break;
                }
                case 'call-reject':
                case 'call-end': {
                    const wasAccepted = activeCallRef.current?.isAccepted;
                    const active = activeCallRef.current;
                    
                    if (active) {
                        const duration = callStartTimeRef.current ? Math.floor((Date.now() - callStartTimeRef.current) / 1000) : 0;
                        await callDbService.saveCallLog({
                            id: active.callId || active.roomId || 'unknown',
                            contactId: active.contactId,
                            contactName: active.contactName || getSuperuserName(active.contactId) || 'User',
                            avatar: active.avatar || '',
                            time: callStartTimeRef.current ? new Date(callStartTimeRef.current).toISOString() : new Date().toISOString(),
                            type: active.isIncoming ? 'incoming' : 'outgoing',
                            status: wasAccepted ? 'completed' : (active.isIncoming ? 'missed' : 'rejected'),
                            callType: active.type,
                            duration
                        });
                        fetchCalls();
                    }

                    if (webRTCService) try { webRTCService.cleanup(); } catch (_) {}
                    setActiveCall(null);
                    incomingSignalRef.current = null;
                    callStartTimeRef.current = null;
                    callService.cleanup('remote-terminated');
                    break;
                }
                case 'call-ringing':
                    setActiveCall(prev => prev ? { ...prev, isRinging: true } : null);
                    break;
                case 'video-toggle':
                    setActiveCall(prev => prev ? { ...prev, remoteVideoOff: signal.payload?.videoOff } : null);
                    break;
                case 'audio-toggle':
                    setActiveCall(prev => prev ? { ...prev, remoteMuted: signal.payload?.muted } : null);
                    break;
                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    if (webRTCService) {
                        try {
                            if (signal.type === 'offer' && !webRTCService.peerConnection) {
                                webRTCService.setInitiator(false);
                            }
                            webRTCService.handleSignal(signal);
                        } catch (e) {}
                    }
                    break;
            }
        };

        callService.addListener(signalHandler);
        fetchCalls();
        
        const callSub = supabase.channel('public:call_logs')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_logs' }, () => fetchCalls())
            .subscribe();

        return () => {
            callService.removeListener(signalHandler);
            callService.cleanup('unmount');
            nativeCallBridge.cleanup();
            supabase.removeChannel(callSub);
        };
    }, [currentUser, fetchCalls]);

    const startCall = useCallback(async (contactId: string, type: 'audio' | 'video') => {
        const roomId = await callService.startCall(contactId, type);
        if (roomId) {
            const contactName = getSuperuserName(contactId) || 'User';
            setActiveCall({
                callId: roomId,
                contactId,
                contactName,
                type,
                isIncoming: false,
                isAccepted: false,
                isMuted: false,
                isVideoOff: false,
                isMinimized: false,
                remoteVideoOff: false,
                roomId
            });
            callStartTimeRef.current = null;
        }
    }, [currentUser]);

    const acceptCall = useCallback(async () => {
        const signal = incomingSignalRef.current;
        if (!signal) return;
        
        setActiveCall(prev => prev ? { ...prev, isAccepted: true } : null);
        callStartTimeRef.current = Date.now();
        callService.acceptCall(signal).catch(() => {});
        incomingSignalRef.current = null;
    }, []);

    const endCall = useCallback(async () => {
        const active = activeCallRef.current;
        if (active) {
            const duration = callStartTimeRef.current ? Math.floor((Date.now() - callStartTimeRef.current) / 1000) : 0;
            await callDbService.saveCallLog({
                id: active.callId || active.roomId || 'unknown',
                contactId: active.contactId,
                contactName: active.contactName || getSuperuserName(active.contactId) || 'User',
                avatar: active.avatar || '',
                time: callStartTimeRef.current ? new Date(callStartTimeRef.current).toISOString() : new Date().toISOString(),
                type: active.isIncoming ? 'incoming' : 'outgoing',
                status: active.isAccepted ? 'completed' : 'rejected',
                callType: active.type,
                duration
            });
            fetchCalls();
        }

        if (webRTCService) try { webRTCService.cleanup(); } catch (_) {}
        await callService.endCall();
        setActiveCall(null);
        callStartTimeRef.current = null;
    }, [fetchCalls]);

    const toggleMute = useCallback(() => {
        setActiveCall(prev => {
            if (!prev) return null;
            const newMuted = !prev.isMuted;
            if (webRTCService) try { webRTCService.toggleMute(); } catch (_) {}
            
            callService.sendSignal({
                type: 'audio-toggle',
                callId: prev.callId || prev.roomId || '',
                callerId: currentUser?.id || '',
                calleeId: prev.contactId,
                callType: prev.type,
                payload: { muted: newMuted },
                timestamp: new Date().toISOString(),
                roomId: prev.roomId,
            }).catch(() => {});
            
            return { ...prev, isMuted: newMuted };
        });
    }, [currentUser]);

    const toggleVideo = useCallback(() => {
        setActiveCall(prev => {
            if (!prev) return null;
            const newVideoOff = !prev.isVideoOff;
            if (webRTCService) try { webRTCService.toggleVideo(); } catch (_) {}
            
            callService.sendSignal({
                type: 'video-toggle',
                callId: prev.callId || prev.roomId || '',
                callerId: currentUser?.id || '',
                calleeId: prev.contactId,
                callType: prev.type,
                payload: { videoOff: newVideoOff },
                timestamp: new Date().toISOString(),
                roomId: prev.roomId,
            }).catch(() => {});
            
            return { ...prev, isVideoOff: newVideoOff };
        });
    }, [currentUser]);

    const deleteCall = useCallback(async (id: string) => {
        setCalls(prev => prev.filter(c => c.id !== id));
        await callDbService.deleteCallLog(id);
        await supabase.from('call_logs').delete().eq('id', id);
    }, []);

    const clearCalls = useCallback(async () => {
        if (!currentUser) return;
        setCalls([]);
        await callDbService.clearCallLogs();
        await supabase.from('call_logs').delete().or(`caller_id.eq.${currentUser.id},callee_id.eq.${currentUser.id}`);
    }, [currentUser]);

    const value = {
        activeCall,
        calls,
        startCall,
        acceptCall,
        endCall,
        toggleMinimizeCall: (val: boolean) => setActiveCall(prev => prev ? { ...prev, isMinimized: val } : null),
        toggleMute,
        toggleVideo,
        deleteCall,
        clearCalls,
    };

    return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
};

export const useCall = () => {
    const context = useContext(CallContext);
    if (context === undefined) throw new Error('useCall must be used within a CallProvider');
    return context;
};
