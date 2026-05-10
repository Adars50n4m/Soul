import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { AppState } from 'react-native';
import {
    theaterSyncService,
    TheaterPlaybackState,
    TheaterAction,
    TheaterViewer,
    TheaterVideoMeta,
} from '../services/TheaterSyncService';
import { theaterRoomService, TheaterRoomState } from '../services/TheaterRoomService';
import { useAuth } from './AuthContext';

const PING_INTERVAL_MS = 15_000;
const CLOCK_SYNC_RTT_THRESHOLD_MS = 500;

export type RemoteEventType = 'update' | 'sync_request' | 'ping' | 'pong';

export interface TheaterRemoteEvent {
    state: TheaterPlaybackState;
    type: RemoteEventType;
    /** Estimated host wall-clock time when emitted, after applying clockOffset */
    estimatedRemoteAt: number;
    /** Drift between estimated remote time and our local time (ms). */
    driftMs: number;
}

interface TheaterContextType {
    currentSessionId: string | null;
    isConnected: boolean;
    isClockSynced: boolean;
    clockOffsetMs: number;

    joinSession: (sessionId: string) => void;
    leaveSession: (sessionId?: string) => void;

    broadcastState: (input: {
        isPlaying: boolean;
        positionMs: number;
        action?: TheaterAction;
        videoMeta?: TheaterVideoMeta;
    }) => void;
    requestSync: () => void;

    /** Subscribe to remote state events. Returns an unsubscribe fn. */
    subscribe: (cb: (evt: TheaterRemoteEvent) => void) => () => void;

    /** Latest remote heartbeat / action observed (excluding pings/pongs). */
    lastRemoteState: TheaterPlaybackState | null;

    /**
     * Live roster of every device currently subscribed to the session
     * channel — sourced from Supabase's built-in presence and refreshed on
     * join/leave/sync. Includes the local user. Independent of the WebRTC
     * mesh, so a silent viewer (no cam/mic) still shows up.
     */
    viewers: TheaterViewer[];

    // ─── WebRTC participant room (Phase 3c) ─────────────────────────────────
    /** Live snapshot of the WebRTC mesh — participants, local stream, toggles. */
    roomState: TheaterRoomState;
    isRoomAvailable: boolean;
    enableCamera: () => Promise<void>;
    disableCamera: () => void;
    enableMic: () => Promise<void>;
    disableMic: () => void;
    switchCamera: () => void;
}

const TheaterContext = createContext<TheaterContextType | undefined>(undefined);

export const TheaterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { currentUser } = useAuth() as any;

    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
    const [isClockSynced, setIsClockSynced] = useState(false);
    const [lastRemoteState, setLastRemoteState] = useState<TheaterPlaybackState | null>(null);
    const [viewers, setViewers] = useState<TheaterViewer[]>([]);
    const [roomState, setRoomState] = useState<TheaterRoomState>(() => ({
        inRoom: false,
        sessionId: null,
        localStream: null,
        cameraEnabled: false,
        micEnabled: false,
        cameraFacing: 'user',
        participants: new Map(),
    }));

    const clockOffsetRef = useRef(0);
    const subscribersRef = useRef<Set<(evt: TheaterRemoteEvent) => void>>(new Set());
    const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        const unsub = theaterRoomService.subscribe((s) => setRoomState(s));
        return () => unsub();
    }, []);

    const startPingLoop = useCallback(() => {
        if (pingIntervalRef.current) return;
        pingIntervalRef.current = setInterval(() => {
            theaterSyncService.sendPing();
        }, PING_INTERVAL_MS);
        // Send the first ping immediately so we converge quickly after joining.
        setTimeout(() => theaterSyncService.sendPing(), 250);
    }, []);

    const stopPingLoop = useCallback(() => {
        if (pingIntervalRef.current) {
            clearInterval(pingIntervalRef.current);
            pingIntervalRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (!currentUser?.id) return;

        theaterSyncService.initialize(currentUser.id, (state, eventType) => {
            // Ping handshake
            if (eventType === 'ping') {
                theaterSyncService.sendPong(state.updatedAt);
                return;
            }

            if (eventType === 'pong') {
                const now = Date.now();
                // We placed our original ping time in `position` when sending pong.
                const rtt = now - (state.position || 0);
                if (rtt < 0 || rtt > CLOCK_SYNC_RTT_THRESHOLD_MS) {
                    return;
                }
                const remoteClockAtTarget = state.updatedAt + rtt / 2;
                const newOffset = remoteClockAtTarget - now;
                clockOffsetRef.current = clockOffsetRef.current === 0
                    ? newOffset
                    : clockOffsetRef.current * 0.9 + newOffset * 0.1;
                if (!theaterSyncService.isClockSynced()) {
                    theaterSyncService.markClockSynced();
                    setIsClockSynced(true);
                }
                return;
            }

            // sync_request — let subscribers respond if they hold authoritative state.
            // update — heartbeat or explicit action from a peer.
            const now = Date.now();
            const estimatedRemoteAt = state.updatedAt;
            const driftMs = now + clockOffsetRef.current - estimatedRemoteAt;

            if (eventType === 'update') {
                setLastRemoteState(state);
            }

            const evt: TheaterRemoteEvent = {
                state,
                type: eventType,
                estimatedRemoteAt,
                driftMs,
            };
            subscribersRef.current.forEach((cb) => {
                try { cb(evt); } catch (err) { console.warn('[TheaterContext] subscriber threw:', err); }
            });
        });

        // Wire the presence roster into React state so consumers re-render
        // when someone joins/leaves the room.
        theaterSyncService.setViewerListHandler((next) => setViewers(next));

        return () => {
            stopPingLoop();
            theaterSyncService.setViewerListHandler(null);
            theaterSyncService.cleanup();
        };
    }, [currentUser?.id, stopPingLoop]);

    // Reconnect after coming back to foreground.
    useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state !== 'active') return;
            if (theaterSyncService.getCurrentScope().type === 'session' &&
                theaterSyncService.getConnectionStatus() === 'disconnected') {
                theaterSyncService.forceReconnect();
            }
        });
        return () => sub.remove();
    }, []);

    const joinSession = useCallback((sessionId: string) => {
        if (!sessionId) return;
        if (currentSessionId === sessionId) return;
        clockOffsetRef.current = 0;
        setIsClockSynced(false);
        setLastRemoteState(null);
        theaterSyncService.joinSession(sessionId);
        
        // Ensure WebRTC connection is initialized immediately so users appear in the participant list
        if (currentUser?.id) {
            theaterRoomService.joinRoom(sessionId, currentUser.id).catch(err => {
                console.warn('[TheaterContext] Failed to join WebRTC room:', err);
            });
        }
        
        setCurrentSessionId(sessionId);
        startPingLoop();
        // Request whatever state peers already have, in case we're a late joiner.
        setTimeout(() => theaterSyncService.requestSync(), 400);
    }, [currentSessionId, startPingLoop, currentUser?.id]);

    const leaveSession = useCallback((sessionId?: string) => {
        if (sessionId && currentSessionId !== sessionId) return;
        stopPingLoop();
        theaterRoomService.leaveRoom();
        theaterSyncService.leaveSession(sessionId);
        setCurrentSessionId(null);
        setIsClockSynced(false);
        setLastRemoteState(null);
        setViewers([]);
    }, [currentSessionId, stopPingLoop]);

    const enableCamera = useCallback(async () => {
        if (!currentSessionId || !currentUser?.id) return;
        await theaterRoomService.joinRoom(currentSessionId, currentUser.id);
        await theaterRoomService.enableCamera();
    }, [currentSessionId, currentUser?.id]);

    const disableCamera = useCallback(() => {
        theaterRoomService.disableCamera();
    }, []);

    const enableMic = useCallback(async () => {
        if (!currentSessionId || !currentUser?.id) return;
        await theaterRoomService.joinRoom(currentSessionId, currentUser.id);
        await theaterRoomService.enableMic();
    }, [currentSessionId, currentUser?.id]);

    const disableMic = useCallback(() => {
        theaterRoomService.disableMic();
    }, []);

    const switchCamera = useCallback(() => {
        theaterRoomService.switchCamera();
    }, []);

    const broadcastState = useCallback((input: {
        isPlaying: boolean;
        positionMs: number;
        action?: TheaterAction;
        videoMeta?: TheaterVideoMeta;
    }) => {
        if (!currentSessionId) return;
        theaterSyncService.broadcastUpdate({
            sessionId: currentSessionId,
            isPlaying: input.isPlaying,
            position: Math.max(0, Math.round(input.positionMs)),
            action: input.action,
            videoMeta: input.videoMeta,
        });
    }, [currentSessionId]);

    const requestSync = useCallback(() => {
        theaterSyncService.requestSync();
    }, []);

    const subscribe = useCallback((cb: (evt: TheaterRemoteEvent) => void) => {
        subscribersRef.current.add(cb);
        return () => {
            subscribersRef.current.delete(cb);
        };
    }, []);

    const value = useMemo<TheaterContextType>(() => ({
        currentSessionId,
        isConnected: !!currentSessionId,
        isClockSynced,
        clockOffsetMs: clockOffsetRef.current,
        joinSession,
        leaveSession,
        broadcastState,
        requestSync,
        subscribe,
        lastRemoteState,
        viewers,
        roomState,
        isRoomAvailable: theaterRoomService.isAvailable(),
        enableCamera,
        disableCamera,
        enableMic,
        disableMic,
        switchCamera,
    }), [
        currentSessionId,
        isClockSynced,
        joinSession,
        leaveSession,
        broadcastState,
        requestSync,
        subscribe,
        lastRemoteState,
        viewers,
        roomState,
        enableCamera,
        disableCamera,
        enableMic,
        disableMic,
        switchCamera,
    ]);

    return (
        <TheaterContext.Provider value={value}>{children}</TheaterContext.Provider>
    );
};

export const useTheater = (): TheaterContextType => {
    const ctx = useContext(TheaterContext);
    if (!ctx) {
        // Safe fallback so screens don't crash if mounted outside the provider during HMR.
        return {
            currentSessionId: null,
            isConnected: false,
            isClockSynced: false,
            clockOffsetMs: 0,
            joinSession: () => {},
            leaveSession: () => {},
            broadcastState: () => {},
            requestSync: () => {},
            subscribe: () => () => {},
            lastRemoteState: null,
            viewers: [],
            roomState: {
                inRoom: false,
                sessionId: null,
                localStream: null,
                cameraEnabled: false,
                micEnabled: false,
                cameraFacing: 'user',
                participants: new Map(),
            },
            isRoomAvailable: false,
            enableCamera: async () => {},
            disableCamera: () => {},
            enableMic: async () => {},
            disableMic: () => {},
            switchCamera: () => {},
        };
    }
    return ctx;
};
