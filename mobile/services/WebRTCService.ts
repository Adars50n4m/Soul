import { NativeModules, Platform, PermissionsAndroid } from 'react-native';
import { normalizeId } from '../utils/idNormalization';
import Constants from 'expo-constants';
import { Audio as ExpoAudio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { callService, CallSignal } from './CallService';
import * as ENV from '../config/env';

// Safe imports for WebRTC core modules.
// Importing the root package eagerly also loads RTCView, which can fail in
// builds where the video view manager is unavailable even if core calling works.
let RTCPeerConnection: any;
let RTCSessionDescription: any;
let RTCIceCandidate: any;
let mediaDevices: any;
let MediaStream: any;
let webRTCCoreLoadError: string | null = null;
let webRTCNativeModule: any = null;
let webRTCNativeReady = false;

try {
    webRTCNativeModule = (NativeModules as any)?.WebRTCModule ?? null;
    webRTCNativeReady =
        !!webRTCNativeModule &&
        typeof webRTCNativeModule.peerConnectionInit === 'function' &&
        typeof webRTCNativeModule.getUserMedia === 'function';
    if (!webRTCNativeReady) {
        webRTCCoreLoadError =
            'WebRTC native module missing in this build. Rebuild Android/iOS dev client after prebuild.';
        console.log('[WebRTCService] WebRTC native module unavailable:', {
            hasModule: !!webRTCNativeModule,
            hasPeerConnectionInit: typeof webRTCNativeModule?.peerConnectionInit === 'function',
            hasGetUserMedia: typeof webRTCNativeModule?.getUserMedia === 'function',
        });
    }
} catch (e: any) {
    webRTCCoreLoadError = e?.message || 'unknown-native-module-error';
    console.log('[WebRTCService] Failed to inspect WebRTC native module:', webRTCCoreLoadError);
}

try {
    RTCPeerConnection = require('react-native-webrtc/lib/commonjs/RTCPeerConnection').default;
    RTCSessionDescription = require('react-native-webrtc/lib/commonjs/RTCSessionDescription').default;
    RTCIceCandidate = require('react-native-webrtc/lib/commonjs/RTCIceCandidate').default;
    mediaDevices = require('react-native-webrtc/lib/commonjs/MediaDevices').default;
    MediaStream = require('react-native-webrtc/lib/commonjs/MediaStream').default;

    // CRITICAL: The main package entry (react-native-webrtc/index) calls setupNativeEvents()
    // which bridges native WebRTC events to JS. Since we import individual files to avoid
    // eagerly loading RTCView, we must call it explicitly — without this, NO events
    // (ICE candidates, connection state, gathering state, etc.) reach JavaScript.
    const { setupNativeEvents } = require('react-native-webrtc/lib/commonjs/EventEmitter');
    setupNativeEvents();
    console.log('[WebRTCService] ✅ setupNativeEvents() bridge activated');
} catch (e: any) {
    webRTCCoreLoadError = webRTCCoreLoadError || e?.message || 'unknown';
    console.log('[WebRTCService] Native modules not available:', webRTCCoreLoadError);
}

// Global reference for InCallManager
let InCallManager: any = null;
try {
    InCallManager = require('react-native-incall-manager').default;
    console.log('[WebRTCService] InCallManager loaded successfully');
} catch (e) {
    console.warn('[WebRTCService] InCallManager not available:', e);
}

// STUN/TURN servers for NAT traversal
//
// WHY TURN IS CRITICAL:
//   - STUN alone only works when both devices are on the same network (WiFi ↔ WiFi)
//   - When either user is on 4G/5G or behind a strict NAT/firewall, STUN fails
//   - TURN relays media through the server as a fallback — this is what WhatsApp does
//
// CURRENT SETUP:
//   1. Google STUN (fast, for same-network / simple NAT)
//   2. Open Relay Project by Metered (free TURN — works on 4G/5G cross-network, no signup)
//   3. ENV-configured TURN (for production self-hosted / paid upgrade)
//
const buildTurnEntries = (server: string, user: string, pass: string): any[] => {
  if (!server || server.length < 4 || server.includes('yourdomain') || server.includes('backup-turn')) return [];
  // Standard format: turn:host:port (avoid query params that can crash some native builds)
  return [
    { urls: 'turn:' + server, username: user, credential: pass },
  ];
};

const CUSTOM_TURN_SERVERS: any[] = [
  ...buildTurnEntries(ENV.TURN_SERVER, ENV.TURN_USERNAME, ENV.TURN_PASSWORD),
  ...buildTurnEntries(ENV.TURN_SERVER_2, ENV.TURN_USERNAME_2, ENV.TURN_PASSWORD_2),
];

// FREE TURN FALLBACK
//
// HOW TO GET WORKING TURN (required for emulator↔simulator & cross-network):
//   1. Go to https://www.metered.ca/stun-turn  (free 500GB/mo, no credit card)
//   2. Sign up → Dashboard → TURN Server → Copy credentials
//   3. Paste into .env:
//        EXPO_PUBLIC_TURN_SERVER=a]standard.relay.metered.ca:443
//        EXPO_PUBLIC_TURN_USERNAME=<your API key>
//        EXPO_PUBLIC_TURN_PASSWORD=<your API secret>
//
// Without TURN, calls only work on the SAME WiFi network.
// Emulator ↔ Simulator ALWAYS needs TURN (different virtual networks).
//
// OpenRelay Project — free public TURN, no signup needed
// Source: https://www.metered.ca/tools/openrelay/
const OPEN_RELAY_TURN_SERVERS: any[] = [
  // STUN servers (for discovering public IPs)
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'stun:stun.relay.metered.ca:443' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.l.google.com:443' }, // Backup port 443
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.voiparound.com:3478' },
  { urls: 'stun:stun.nextcloud.com:3478' },
  // OpenRelay TURN — free, no signup, works from any network
  { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

// Runtime TURN credential cache (fetched from Metered API at call time)
let _cachedMeteredTurnServers: any[] = [];
let _cachedMeteredTurnExpiry: number = 0;

async function fetchMeteredTurnCredentials(): Promise<any[]> {
  const apiKey = ENV.METERED_API_KEY;
  if (!apiKey || apiKey.length < 5) return [];

  // Return cached if fresh (credentials last 24h, we refresh every 12h)
  if (_cachedMeteredTurnServers.length > 0 && Date.now() < _cachedMeteredTurnExpiry) {
    return _cachedMeteredTurnServers;
  }

  try {
    console.log('[WebRTCService] 🔑 Fetching TURN credentials from Metered.ca...');
    const response = await fetch(
      `https://soul.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } }
    );

    if (!response.ok) {
      console.warn('[WebRTCService] Metered API error:', response.status);
      return [];
    }

    const credentials = await response.json();
    if (Array.isArray(credentials) && credentials.length > 0) {
      _cachedMeteredTurnServers = credentials;
      _cachedMeteredTurnExpiry = Date.now() + 12 * 60 * 60 * 1000; // 12h
      console.log(`[WebRTCService] ✅ Got ${credentials.length} TURN servers from Metered`);
      return credentials;
    }
  } catch (error: any) {
    console.warn('[WebRTCService] Failed to fetch Metered TURN:', error?.message);
  }

  return [];
}

const LOCAL_TURN_USER = 'openrelayproject';
const LOCAL_TURN_PASS = 'openrelayproject';

// DYNAMIC LOCAL TURN: Correctly bridge Emulator -> Host machine
const getLocalTurnServers = (): any[] => {
  if (!Constants.isDevice) {
    // Android Emulator needs 10.0.2.2 to reach host services.
    // iOS Simulator can use 127.0.0.1.
    const host = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
    return [
      { urls: `turn:${host}:3478?transport=tcp`, username: LOCAL_TURN_USER, credential: LOCAL_TURN_PASS },
      { urls: `turn:${host}:3478?transport=udp`, username: LOCAL_TURN_USER, credential: LOCAL_TURN_PASS },
      { urls: `stun:${host}:3478` }
    ];
  }
  return [];
};

const ICE_SERVERS: any[] = [
  ...getLocalTurnServers(),
  ...CUSTOM_TURN_SERVERS,
  ...OPEN_RELAY_TURN_SERVERS,
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const SAFE_FALLBACK_STUN_SERVERS: any[] = [
  ...getLocalTurnServers(), // Include local even in fallback
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const HAS_CUSTOM_TURN =
    CUSTOM_TURN_SERVERS.length > 0;

type CallType = 'audio' | 'video';
type CallState = 'idle' | 'ringing' | 'connecting' | 'connected' | 'ended';
type AudioOutput = 'speaker' | 'earpiece';

const IOS_CALL_INTERRUPTION_MODE =
    (InterruptionModeIOS as any)?.DoNotMix ?? 1;
const ANDROID_CALL_INTERRUPTION_MODE =
    (InterruptionModeAndroid as any)?.DoNotMix ?? 1;

interface WebRTCCallbacks {
    onStateChange: (state: CallState) => void;
    onLocalStream: (stream: MediaStream | null) => void;
    onRemoteStream: (stream: MediaStream | null, userId?: string) => void;
    onPeerStateChange?: (userId: string, state: string) => void;
    onError: (error: string) => void;
}

class WebRTCService {
    private peerConnections: Map<string, RTCPeerConnection> = new Map();
    private listeners: WebRTCCallbacks[] = [];
    private localStream: MediaStream | null = null;
    private remoteStreams: Map<string, MediaStream> = new Map();

    getRemoteStreams(): Map<string, MediaStream> {
        return this.remoteStreams;
    }
    private lastStats: any = { bytesReceived: 0 };
    private callType: CallType = 'audio';
    private callState: CallState = 'idle';
    private isInitiator: boolean = false;
    private partnerHasAccepted: boolean = false;
    private pendingParticipants: Set<string> = new Set();
    private pendingCandidates: Map<string, RTCIceCandidate[]> = new Map();
    private earlySignalQueue: CallSignal[] = [];
    private pendingCandidatesMutex: boolean = false;
    private mediaStreamAttempted: boolean = false;
    private readonly SIGNAL_POLL_OVERLAP_MS = 10000;
    private readonly MAX_PENDING_CANDIDATES = 50;
    private signalingRole: 'offerer' | 'answerer' | 'none' = 'none';

    // Recovery tracking
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private connectionWatchdog: NodeJS.Timeout | null = null;
    private trackMonitorTimer: NodeJS.Timeout | null = null;
    private readonly TRACK_MONITOR_INTERVAL_MS = 3000;
    private lastDisconnectTime: number = 0;
    private lastRecoveryAttemptAt: number = 0;
    private readonly RECOVERY_COOLDOWN_MS = 12000;
    private offerRetryTimer: NodeJS.Timeout | null = null;
    private offerRetryAttempts: number = 0;
    private readonly MAX_OFFER_RETRIES = 6;
    private micPermissionGranted: boolean = false;
    private isAudioSessionActive: boolean = false;
    private speakerEnabled: boolean = false;
    private hasManualAudioOutputOverride: boolean = false;

    isAvailable(): boolean {
        return webRTCNativeReady
            && !!RTCPeerConnection
            && !!RTCSessionDescription
            && !!RTCIceCandidate
            && !!mediaDevices
            && !!MediaStream;
    }

    getAvailabilityError(): string {
        if (!webRTCNativeReady) {
            return webRTCCoreLoadError
                || 'WebRTC native module missing in current binary. Build a dev client with react-native-webrtc linked.';
        }
        return webRTCCoreLoadError || 'WebRTC core modules are unavailable in the current build.';
    }

    private ensureTurnReadinessOrThrow(): void {
        if (ENV.CALL_REQUIRE_CUSTOM_TURN && !HAS_CUSTOM_TURN) {
            const message =
                'Calling is blocked: custom TURN server is not configured. Set EXPO_PUBLIC_TURN_SERVER/USERNAME/PASSWORD.';
            console.error('[WebRTCService] ' + message);
            this.broadcast('onError', message);
            throw new Error(message);
        }
    }

    private getPreferredSpeakerForCallType(callType: CallType = this.callType): boolean {
        if (!Constants.isDevice) {
            // Simulators/emulators generally do not have a real earpiece route.
            return true;
        }
        return callType === 'video';
    }

    async ensureMicrophonePermission(autoRequest: boolean = true): Promise<boolean> {
        if (this.micPermissionGranted) {
            return true;
        }

        try {
            const currentPermission = await ExpoAudio.getPermissionsAsync();
            if (currentPermission.granted) {
                this.micPermissionGranted = true;
                return true;
            }

            if (autoRequest) {
                const requestedPermission = await ExpoAudio.requestPermissionsAsync();
                if (requestedPermission.granted) {
                    this.micPermissionGranted = true;
                    return true;
                }
            }
        } catch (error: any) {
            console.warn('[WebRTCService] Expo microphone permission check failed:', error?.message || error);
        }

        if (Platform.OS === 'android' && PermissionsAndroid?.PERMISSIONS?.RECORD_AUDIO) {
            try {
                const status = await PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
                );
                if (status === PermissionsAndroid.RESULTS.GRANTED) {
                    this.micPermissionGranted = true;
                    return true;
                }
            } catch (error: any) {
                console.warn('[WebRTCService] Android microphone permission check failed:', error?.message || error);
            }
        }

        this.micPermissionGranted = false;
        return false;
    }

    getAudioOutput(): AudioOutput {
        return this.speakerEnabled ? 'speaker' : 'earpiece';
    }

    isSpeakerEnabled(): boolean {
        return this.speakerEnabled;
    }

    private async applyExpoCallAudioMode(): Promise<void> {
        const isSimulator = Platform.OS === 'ios' && !Constants.isDevice;
        
        await ExpoAudio.setAudioModeAsync({
            allowsRecordingIOS: true,
            playsInSilentModeIOS: true,
            staysActiveInBackground: true,
            interruptionModeIOS: IOS_CALL_INTERRUPTION_MODE,
            shouldDuckAndroid: false,
            interruptionModeAndroid: ANDROID_CALL_INTERRUPTION_MODE,
            playThroughEarpieceAndroid: !this.speakerEnabled,
        });
    }

    private applyNativeAudioRoute(): void {
        if (!InCallManager) return;

        try {
            InCallManager.setSpeakerphoneOn(this.speakerEnabled);
            InCallManager.setForceSpeakerphoneOn(this.speakerEnabled);
            InCallManager.setMicrophoneMute(false);
        } catch (error) {
            console.warn('[WebRTCService] Failed to apply native audio route:', error);
        }
    }

    async setAudioOutput(output: AudioOutput | boolean, manualOverride: boolean = true): Promise<void> {
        const nextSpeakerState = typeof output === 'boolean' ? output : output === 'speaker';
        this.speakerEnabled = nextSpeakerState;
        if (manualOverride) {
            this.hasManualAudioOutputOverride = true;
        }

        if (!this.isAudioSessionActive && this.callState !== 'ringing' && this.callState !== 'connecting' && this.callState !== 'connected') {
            return;
        }

        try {
            await this.applyExpoCallAudioMode();
            this.applyNativeAudioRoute();
        } catch (error) {
            console.warn('[WebRTCService] Failed to set audio output:', error);
        }
    }

    private async activateAudioSession(context: string): Promise<void> {
        const micGranted = await this.ensureMicrophonePermission(true);
        if (!micGranted) {
            throw new Error('Microphone permission is required for calling.');
        }

        const isSimulator = Platform.OS === 'ios' && !Constants.isDevice;

        if (!this.hasManualAudioOutputOverride) {
            this.speakerEnabled = this.getPreferredSpeakerForCallType(this.callType);
        }

        try {
            await this.applyExpoCallAudioMode();
            // Sequential buffer: Give ExpoAudio a moment to settle the native category change
            if (isSimulator) await new Promise(r => setTimeout(r, 200));
        } catch (error) {
            console.warn('[WebRTCService] Failed to apply Expo call audio mode:', error);
        }

        if (InCallManager) {
            try {
                if (!this.isAudioSessionActive) {
                    console.log(`[WebRTCService] 🎙️ Starting InCallManager (${this.callType})...`);
                    InCallManager.start({ 
                        media: this.callType,
                        ringback: '', // Explicitly disable builtin ringback if any
                    });
                }
                InCallManager.setKeepScreenOn(true);
                this.applyNativeAudioRoute();
            } catch (error) {
                console.warn('[WebRTCService] Failed to activate native audio session:', error);
            }
        }

        this.isAudioSessionActive = true;
        
        // CRITICAL SIMULATOR FIX: 
        // The VoiceProcessingAudioUnit initialization (triggered by setLocalDescription later)
        // often timeouts if called immediately after session activation on the simulator.
        if (isSimulator) {
            console.log('[WebRTCService] 🛡️ Simulator detected: applying defensive 800ms stabilization delay...');
            await new Promise(r => setTimeout(r, 800));
        } else {
            // Even on physical devices, a tiny buffer helps prevent Race Conditions in the audio daemon
            await new Promise(r => setTimeout(r, 100));
        }

        console.log(`[WebRTCService] Audio session active (${context}) output=${this.getAudioOutput()}`);
    }

    private async deactivateAudioSession(context: string): Promise<void> {
        if (InCallManager) {
            try {
                InCallManager.setKeepScreenOn(false);
                InCallManager.stop();
            } catch (error) {
                console.warn('[WebRTCService] Failed to stop native audio session:', error);
            }
        }

        try {
            await ExpoAudio.setAudioModeAsync({
                allowsRecordingIOS: false,
                playsInSilentModeIOS: true,
                staysActiveInBackground: true,
                interruptionModeIOS: IOS_CALL_INTERRUPTION_MODE,
                shouldDuckAndroid: true,
                interruptionModeAndroid: ANDROID_CALL_INTERRUPTION_MODE,
                playThroughEarpieceAndroid: false,
            });
        } catch (error) {
            console.warn('[WebRTCService] Failed to reset Expo audio mode:', error);
        }

        this.isAudioSessionActive = false;
        this.hasManualAudioOutputOverride = false;
        this.speakerEnabled = false;
        console.log(`[WebRTCService] Audio session released (${context})`);
    }

    private sanitizeIceUrl(url: string): string | null {
        if (typeof url !== 'string') return null;
        const trimmedUrl = url.trim();
        if (!trimmedUrl) return null;

        const lowerUrl = trimmedUrl.toLowerCase();
        const isStun = lowerUrl.startsWith('stun:') || lowerUrl.startsWith('stuns:');
        const isTurn = lowerUrl.startsWith('turn:') || lowerUrl.startsWith('turns:');
        if (!isStun && !isTurn) return null;

        // STUN URLs with query params often break native parsers on iOS.
        if (isStun && trimmedUrl.includes('?')) {
            return trimmedUrl.split('?')[0];
        }

        return trimmedUrl;
    }

    private normalizeIceServer(server: any): any | null {
        if (!server) return null;

        const rawUrls = server.urls ?? server.url;
        const urlCandidates = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
        const sanitizedUrls = urlCandidates
            .map((candidate: any) => this.sanitizeIceUrl(String(candidate || '')))
            .filter((value): value is string => !!value);

        const uniqueUrls: string[] = [];
        sanitizedUrls.forEach((url) => {
            if (!uniqueUrls.includes(url)) {
                uniqueUrls.push(url);
            }
        });

        if (uniqueUrls.length === 0) return null;

        const turnUrls = uniqueUrls.filter((url) => url.toLowerCase().startsWith('turn'));
        const stunUrls = uniqueUrls.filter((url) => !url.toLowerCase().startsWith('turn'));
        const username = typeof server.username === 'string' ? server.username : '';
        const credential = typeof server.credential === 'string' ? server.credential : '';

        // TURN without credentials can break native initialization on iOS.
        if (turnUrls.length > 0 && (!username || !credential)) {
            console.warn('[WebRTCService] Dropping TURN server due to missing credentials');
            if (stunUrls.length === 0) {
                return null;
            }
            return {
                urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls,
            };
        }

        const normalized: any = {
            urls: uniqueUrls.length === 1 ? uniqueUrls[0] : uniqueUrls,
        };

        if (turnUrls.length > 0) {
            normalized.username = username;
            normalized.credential = credential;
        }

        return normalized;
    }

    private async getNormalizedIceServers(): Promise<any[]> {
        const normalizedServers: any[] = [];
        const seenKeys = new Set<string>();

        const appendServer = (server: any): void => {
            const normalized = this.normalizeIceServer(server);
            if (!normalized) return;

            const urls = Array.isArray(normalized.urls) ? normalized.urls : [normalized.urls];
            const key = `${urls.join(',')}|${normalized.username || ''}|${normalized.credential || ''}`;
            if (seenKeys.has(key)) return;

            seenKeys.add(key);
            normalizedServers.push(normalized);
        };

        // 1. Fetch fresh credentials from Metered if API key exists
        const meteredServers = await fetchMeteredTurnCredentials();
        meteredServers.forEach(appendServer);

        // 2. Add static configurations from ICE_SERVERS
        ICE_SERVERS.forEach(appendServer);
        
        if (normalizedServers.length === 0) {
            SAFE_FALLBACK_STUN_SERVERS.forEach(appendServer);
        }

        return normalizedServers;
    }

    private getPrimaryPeerConnectionConfig(iceServers: any[]): any {
        return {
            iceServers,
            sdpSemantics: 'unified-plan',
            iceCandidatePoolSize: 10,
            iceTransportPolicy: ENV.CALL_FORCE_RELAY ? 'relay' : 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
        };
    }

    private async getPeerConnectionConfigs(): Promise<any[]> {
        // 1. Get latest Metered credentials if available
        const meteredServers = await fetchMeteredTurnCredentials();
        
        // 2. Build all available ICE servers (Dynamic + Static + Custom)
        const allServers = [
            ...meteredServers,
            ...CUSTOM_TURN_SERVERS,
            ...OPEN_RELAY_TURN_SERVERS,
            ...SAFE_FALLBACK_STUN_SERVERS,
        ].filter(s => !!s && s?.urls);

        const turnOnlyServers = allServers.filter(
            s => {
                const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
                return urls.some((u: string) => u.startsWith('turn:') || u.startsWith('turns:'));
            }
        );

        const primaryPolicy = 'all';

        console.log(`[WebRTCService] 🛠️ ICE pool refreshed: ${allServers.length} servers (${turnOnlyServers.length} TURN) | Policy: ${primaryPolicy}`);

        return [
            {
                // PRIMARY: uses 'all' to allow STUN/Host fallbacks, but all TURNs are present.
                iceServers: allServers,
                iceTransportPolicy: primaryPolicy,
                iceCandidatePoolSize: 10,
                sdpSemantics: 'unified-plan',
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require',
            },
            {
                // FALLBACK 1: Forced relay for strict firewalls
                iceServers: turnOnlyServers.length > 0 ? turnOnlyServers : allServers,
                iceTransportPolicy: 'relay',
                iceCandidatePoolSize: 5,
                sdpSemantics: 'unified-plan',
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require',
            },
            {
                // FALLBACK 2: TCP only and Secure Ports
                iceServers: allServers.filter(s => {
                    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
                    return urls.some((u: string) => u.includes('tcp') || u.startsWith('stun:') || (u.startsWith('turn:') && u.includes('443')));
                }),
                iceTransportPolicy: 'all',
                iceCandidatePoolSize: 3,
                sdpSemantics: 'unified-plan',
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require',
            },
        ];
    }

    private tryCreatePeerConnection(config: any, label: string, userId: string): RTCPeerConnection {
        const iceServers = config?.iceServers || [];
        const policy = config?.iceTransportPolicy || 'all';
        
        console.log(`[WebRTCService] [BRIDGE] 🚀 Initializing [${label}] for user ${userId}`);
        console.log(`[WebRTCService] [BRIDGE] 🛠️ Policy: ${policy.toUpperCase()}`);
        
        iceServers.forEach((s: any, idx: number) => {
            const urls = Array.isArray(s.urls) ? s.urls.join(', ') : s.urls;
            console.log(`[WebRTCService] [BRIDGE] 📍 ICE Server ${idx + 1}: ${urls}`);
        });

        const pc = new RTCPeerConnection(config);

        // --- DEFENSIVE STATE LOGGING & RECOVERY ---
        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            console.log(`[WebRTCService] [${label}] 🧊 ICE State: ${state.toUpperCase()}`);
            
            if (state === 'failed') {
                console.error('[WebRTCService] ❌ ICE Failed — attempting restart');
                // Try ICE restart
                this.attemptIceRestart().catch(err => {
                    console.error('[WebRTCService] ICE restart failed:', err);
                });
            }
            if (state === 'connected' || state === 'completed') {
                console.log('[WebRTCService] ✅ ICE connected — media path confirmed');
                this.setState('connected');
                this.reconnectAttempts = 0; // Reset on successful connection
                if (this.connectionWatchdog) {
                    clearTimeout(this.connectionWatchdog);
                    this.connectionWatchdog = null;
                }
            }
            if (state === 'disconnected') {
                console.warn('[WebRTCService] ⚠️ ICE disconnected — starting watchdog');
                this.startConnectionWatchdog();
            }
            if (state === 'checking') {
                // If we stay in checking for more than 10-12s, the watchdog will trigger a restart
                this.startConnectionWatchdog();
            }
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log(`[WebRTCService] [${label}] 🌐 Peer State: ${state.toUpperCase()}`);
            
            switch (state) {
                case 'connected':
                    this.setState('connected');
                    this.reconnectAttempts = 0;
                    if (this.reconnectTimeout) {
                        clearTimeout(this.reconnectTimeout);
                        this.reconnectTimeout = null;
                    }
                    if (this.connectionWatchdog) {
                        clearTimeout(this.connectionWatchdog);
                        this.connectionWatchdog = null;
                    }
                    break;
                case 'disconnected':
                    console.warn('[WebRTCService] ⚠️ Peer disconnected — starting watchdog');
                    this.lastDisconnectTime = Date.now();
                    this.startConnectionWatchdog();
                    break;
                case 'closed':
                    console.log(`[WebRTCService] 🚫 Peer closed: ${userId}`);
                    this.removePeer(userId);
                    break;
            }
        };

        pc.ontrack = (event: any) => {
            if (event.streams && event.streams[0]) {
                console.log(`[WebRTCService] 📺 Remote stream received from ${userId}`);
                this.remoteStreams.set(userId, event.streams[0]);
                this.broadcast('onRemoteStream', event.streams[0], userId);
            }
        };

        // For backward compatibility with older react-native-webrtc versions that use onaddstream
        (pc as any).onaddstream = (event: any) => {
            if (event.stream) {
                console.log(`[WebRTCService] 📺 Remote stream added from ${userId} (legacy)`);
                this.remoteStreams.set(userId, event.stream);
                this.broadcast('onRemoteStream', event.stream, userId);
            }
        };

        pc.onsignalingstatechange = () => {
            console.log(`[WebRTCService] [${label}] 📡 Signaling: ${pc.signalingState.toUpperCase()}`);
        };

        // Track monitor: ensure tracks don't go missing
        this.startTrackMonitor();

        pc.onnegotiationneeded = async () => {
            try {
                if (pc.signalingState !== 'stable') return;
                console.log(`[WebRTCService] [${label}] 🔄 Negotiation needed — ${this.isInitiator ? 'creating offer' : 'waiting for remote'}`);
                
                if (this.isInitiator) {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    await callService.sendOffer(offer, userId);
                }
            } catch (err: any) {
                console.warn(`[WebRTCService] Negotiation failed for ${userId}:`, err?.message);
            }
        };

        let candidateBatch: any[] = [];
        let batchTimer: NodeJS.Timeout | null = null;
        const flushCandidates = () => {
            if (candidateBatch.length === 0) return;

            const pendingBatch = candidateBatch;
            candidateBatch = [];
            batchTimer = null;
            console.log(`[WebRTCService] [${label}] 🧊 Flushing ${pendingBatch.length} ICE candidates to ${userId}`);

            pendingBatch.forEach((candidate) => {
                void callService.sendIceCandidate(candidate, userId).catch((error: any) => {
                    console.warn(`[WebRTCService] Failed to send ICE candidate to ${userId}:`, error?.message || error);
                });
            });
        };

        pc.addEventListener('icecandidate', (event: any) => {
            if (event.candidate) {
                candidateBatch.push(event.candidate);
                if (!batchTimer) {
                    batchTimer = setTimeout(flushCandidates, 150);
                }
                return;
            }

            flushCandidates();
            console.log(`[WebRTCService] [${label}] ICE gathering complete for ${userId}`);
        });

        // --- DIAGNOSTICS: ICE CANDIDATE ERRORS ---
        pc.onicecandidateerror = (event: any) => {
            console.warn(`[WebRTCService] [${label}] 🧊 ICE Candidate Error:`, {
                errorCode: event.errorCode,
                errorText: event.errorText,
                url: event.url,
                msg: "If this mentions port 3478, your local turnserver is rejecting the connection!"
            });
        };

        // Track ICE gathering state
        pc.onicegatheringstatechange = () => {
            console.log(`[WebRTCService] [${label}] 🧊 ICE Gathering: ${pc.iceGatheringState.toUpperCase()}`);
        };

        return pc;
    }

    /**
     * Add a listener for WebRTC events
     */
    addListener(listener: WebRTCCallbacks): void {
        if (!this.listeners.includes(listener)) {
            this.listeners.push(listener);
            console.log(`[WebRTCService] Listener added. Total: ${this.listeners.length}`);
            
            // Immediately sync current state to new listener
            listener.onStateChange(this.callState);
            if (this.localStream) listener.onLocalStream(this.localStream);
            this.remoteStreams.forEach((stream, userId) => {
                listener.onRemoteStream(stream, userId);
            });
        }
    }

    /**
     * Remove a listener
     */
    removeListener(listener: WebRTCCallbacks): void {
        this.listeners = this.listeners.filter(l => l !== listener);
        console.log(`[WebRTCService] Listener removed. Total: ${this.listeners.length}`);
    }

    /**
     * @deprecated Use addListener
     */
    initialize(callbacks: WebRTCCallbacks, isInitiator: boolean): void {
        this.isInitiator = isInitiator;
        this.addListener(callbacks);
        console.log(`[WebRTCService] Initializing Mesh Call. Role: ${isInitiator ? 'Initiator' : 'Receiver'}`);

        if (this.peerConnections.size === 0) {
            this.localStream = null;
            this.mediaStreamAttempted = false;
            this.remoteStreams.clear();
            this.partnerHasAccepted = false;
            this.setState('idle');
            this.pendingCandidates.clear();
        }

        // RE-LINK SIGNALING BRIDGE
        callService.addListener(async (signal) => {
            const { type, payload } = signal;
            const { candidate, offer, answer } = payload || {};
            
            // Only process signals if we are in a relevant call state.
            // ALERT: We MUST allow 'offer' while 'idle' or else the receiver will never answer!
            if (this.callState === 'ended') return;
            if (this.callState === 'idle' && type !== 'offer') return;

            const senderId = normalizeId((signal as any).sender_id || signal.callerId);
            console.log(`[WebRTCService] 📨 Signal received: ${type} from ${senderId}`);

            try {
                switch (type) {
                    case 'offer':
                        if (offer) {
                            await this.answerCall(this.callType, offer, senderId);
                        }
                        break;
                    case 'answer':
                        if (answer) {
                            const pc = this.peerConnections.get(senderId);
                            if (pc) {
                                console.log(`[WebRTCService] 📝 Setting remote description (answer) for ${senderId}`);
                                await pc.setRemoteDescription(new RTCSessionDescription(answer as any));
                                await this.processPendingCandidates(senderId);
                            }
                        }
                        break;
                    case 'ice-candidate':
                        if (candidate) {
                            try {
                                const candidateData = {
                                    candidate: candidate.candidate || candidate,
                                    sdpMid: candidate.sdpMid,
                                    sdpMLineIndex: candidate.sdpMLineIndex
                                };
                                
                                const iceCandidate = new RTCIceCandidate(candidateData);
                                const pc = this.peerConnections.get(senderId);
                                
                                if (pc && pc.remoteDescription && pc.remoteDescription.type) {
                                    console.log(`[WebRTCService] 🧊 Applying remote candidate for ${senderId}`);
                                    await pc.addIceCandidate(iceCandidate);
                                } else {
                                    console.log(`[WebRTCService] 📥 Queueing candidate for ${senderId}`);
                                    if (!this.pendingCandidates.has(senderId)) {
                                        this.pendingCandidates.set(senderId, []);
                                    }
                                    this.pendingCandidates.get(senderId)!.push(iceCandidate);
                                }
                            } catch (e: any) {
                                console.warn(`[WebRTCService] ❌ Failed to add ICE candidate from ${senderId}:`, e.message);
                            }
                        }
                        break;
                    case 'call-accept':
                        // If we are initiator and someone accepts, they join the mesh
                        if (this.isInitiator) {
                            console.log(`[WebRTCService] 👤 Peer ${senderId} accepted — establishing connection`);
                            await this.getOrCreatePeerConnection(senderId);
                        }
                        break;
                    case 'call-end':
                        this.endCall('remote-hangup');
                        break;
                }
            } catch (err) {
                console.warn(`[WebRTCService] ❌ Error processing signal [${type}]:`, err);
            }
        });
    }

    /**
     * @deprecated Use addListener/removeListener
     */
    setCallbacks(callbacks: WebRTCCallbacks | null): void {
        if (callbacks) {
            this.addListener(callbacks);
        }
    }

    /**
     * Set the role of this device (initiator/caller or receiver/callee)
     */
    setInitiator(val: boolean): void {
        this.isInitiator = val;
    }

    /**
     * Get current local stream
     */
    getLocalStream(): MediaStream | null {
        return this.localStream;
    }

    /**
     * Get current remote stream
     */
    getRemoteStream(): MediaStream | null {
        return Array.from(this.remoteStreams.values())[0] || null;
    }

    /**
     * Check if a call is currently active
     */
    isCallActive(): boolean {
        return this.peerConnections.size > 0 && (this.callState === 'connected' || this.callState === 'connecting' || this.callState === 'ringing');
    }

    /**
     * Prepare for a call (get media permissions and stream ONLY — no PeerConnection)
     * PeerConnection is created by startCall() or answerCall() to avoid double-creation.
     */
    async prepareCall(callType: CallType): Promise<void> {
        console.log(`[WebRTCService] 🛠️ prepareCall starting (Type: ${callType})...`);
        this.callType = callType;

        // Only get media — do NOT create PeerConnection or change state here.
        // startCall/answerCall handle PC creation and state transitions.
        if (this.localStream) {
            console.log('[WebRTCService] prepareCall: local stream already exists, skipping');
            return;
        }

        console.log('[WebRTCService] 🎙️ Getting media stream...');
        await this.getMediaStream();
        console.log('[WebRTCService] ✅ prepareCall complete. Stream ready.');
    }

    async startCall(callType: CallType, partnerId?: string, groupId?: string): Promise<string | null> {
        if (this.isCallActive() && this.isInitiator) {
            console.log('[WebRTCService] startCall ignored: Call already active as Initiator.');
            return callService.getCurrentRoomId();
        }

        try {
            if (!this.isAvailable()) {
                const message = this.getAvailabilityError();
                this.broadcast('onError', message);
                throw new Error(message);
            }
            this.ensureTurnReadinessOrThrow();

            console.log(`[WebRTCService] Starting ${callType} call as Initiator (Target: ${groupId || partnerId})`);
            this.isInitiator = true;
            this.callType = callType;
            this.hasManualAudioOutputOverride = false;
            this.speakerEnabled = this.getPreferredSpeakerForCallType(this.callType);
            this.setState('ringing');
            await this.activateAudioSession('start-call');

            // Ensure media is ready. Wait for pending acquisition if needed.
            if (!this.localStream) {
                if (this.mediaStreamAttempted) {
                    console.log('[WebRTCService] ⏳ Waiting for pending media stream (caller)...');
                    let waited = 0;
                    while (!this.localStream && waited < 10000) {
                        await new Promise(r => setTimeout(r, 250));
                        waited += 250;
                    }
                }
                if (!this.localStream) {
                    this.mediaStreamAttempted = false;
                    await this.prepareCall(this.callType);
                }
            }

            if (this.pendingParticipants.size > 0) {
                console.log(`[WebRTCService] ⚡ Flushing ${this.pendingParticipants.size} accepted participant(s) queued before caller was ready`);
                const acceptedParticipants = Array.from(this.pendingParticipants);
                for (const userId of acceptedParticipants) {
                    await this.onCallAccepted(userId);
                }
            }

            return callService.getCurrentRoomId();
        } catch (error: any) {
            console.error('[WebRTCService] Failed to start call:', error);
            this.broadcast('onError', error?.message || 'Failed to start call');
            this.endCall('start-failed');
            return null;
        }
    }

    /**
     * Answer an incoming call
     */
    async answerCall(callType: CallType, offer: any, senderId: string): Promise<void> {
        console.log(`[WebRTCService] 📞 Answering ${callType} call from ${senderId}`);
        this.callType = callType;
        this.isInitiator = false;

        try {
            await this.activateAudioSession('answerCall');
            await this.prepareCall(callType);

            const pc = await this.getOrCreatePeerConnection(senderId);
            
            console.log(`[WebRTCService] 📝 Setting remote description (offer) for ${senderId}`);
            await pc.setRemoteDescription(new RTCSessionDescription(offer as any));
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            await callService.sendAnswer(answer, senderId);
            await this.processPendingCandidates(senderId);
            
            this.setState('connecting');
        } catch (error: any) {
            console.error(`[WebRTCService] Failed to answer call from ${senderId}:`, error);
            this.broadcast('onError', error.message || 'Failed to answer call');
        }
    }

    private async getOrCreatePeerConnection(userId: string): Promise<RTCPeerConnection> {
        if (this.peerConnections.has(userId)) {
            return this.peerConnections.get(userId)!;
        }

        console.log(`[WebRTCService] 🏗️ Creating PeerConnection for user: ${userId}`);
        const configs = this.getPeerConnectionConfigs();
        const pc = this.tryCreatePeerConnection(configs[0], `MeshPeer-${userId.substring(0, 8)}`, userId);
        
        this.peerConnections.set(userId, pc);

        // Add local stream tracks to the connection
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                pc.addTrack(track, this.localStream!);
            });
        }

        return pc;
    }

    private removePeer(userId: string): void {
        console.log(`[WebRTCService] 🗑️ Removing peer: ${userId}`);
        const pc = this.peerConnections.get(userId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(userId);
        }
        
        const stream = this.remoteStreams.get(userId);
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            this.remoteStreams.delete(userId);
            this.broadcast('onRemoteStream', null, userId);
        }

        if (this.peerConnections.size === 0 && this.callState !== 'idle') {
            console.log('[WebRTCService] All peers gone, keeping local session alive for potential newcomers');
            // If it's a group call, we might stay in 'ringing' or 'connected' with 0 peers 
            // but if it's 1:1 and they hang up, we should probably end.
            if (!callService.getCurrentRoomId()) {
                this.endCall('no-peers-remaining');
            }
        }
    }

    private async processPendingCandidates(userId: string): Promise<void> {
        const candidates = this.pendingCandidates.get(userId);
        const pc = this.peerConnections.get(userId);
        
        if (!pc || !candidates || candidates.length === 0) return;

        console.log(`[WebRTCService] 📤 Processing ${candidates.length} pending candidates for ${userId}`);
        
        for (const candidate of candidates) {
            try {
                await pc.addIceCandidate(candidate);
            } catch (e: any) {
                console.warn(`[WebRTCService] Error adding pending candidate for ${userId}:`, e.message);
            }
        }
        
        this.pendingCandidates.delete(userId);
    }

    /**
     * Triggered when a participant joins (receives 'call-accepted')
     */
    async onCallAccepted(userId: string): Promise<void> {
        const normalizedUserId = normalizeId(userId || '');
        if (!normalizedUserId) {
            console.warn('[WebRTCService] onCallAccepted called without a valid user id');
            return;
        }

        this.partnerHasAccepted = true;
        this.pendingParticipants.add(normalizedUserId);
        console.log(`[WebRTCService] ⚡ onCallAccepted from ${normalizedUserId}`);

        if (!this.isInitiator) {
            console.log('[WebRTCService] ⏳ Accept received before caller finished initializing. Queued for later.');
            return;
        }

        try {
            const pc = await this.getOrCreatePeerConnection(normalizedUserId);
            this.pendingParticipants.delete(normalizedUserId);

            if (pc.signalingState === 'stable') {
                this.setState('connecting');
            }
        } catch (error: any) {
            console.error(`[WebRTCService] Failed to connect accepted participant ${normalizedUserId}:`, error);
            this.broadcast('onError', error?.message || 'Failed to connect call');
        }
    }

    /**
     * Handle incoming WebRTC signals
     */
    async handleSignal(signal: CallSignal): Promise<void> {
        const myId = normalizeId(callService.getUserId() || '');
        const senderId = normalizeId(signal.callerId || (signal as any).sender_id);
        
        console.log(`[WebRTCService] 📨 handleSignal: type=${signal.type}, from=${senderId.substring(0, 8)}, state=${this.callState}`);

        if (myId === senderId) {
            console.log(`[WebRTCService] 🔇 Dropping self-echo: ${signal.type}`);
            return;
        }

        try {
            switch (signal.type) {
                case 'offer': {
                    console.log(`[WebRTCService] 🚀 Received offer from ${senderId}`);
                    this.callType = signal.callType || 'audio';
                    this.isInitiator = false;
                    
                    const pc = await this.getOrCreatePeerConnection(senderId);
                    
                    // Glare Protection (Polite/Impolite logic)
                    if (pc.signalingState !== 'stable') {
                        if (myId.toLowerCase() < senderId.toLowerCase()) {
                            console.log('[WebRTCService] 🚨 Signaling glare! We are "impolite", keeping our offer.');
                            return;
                        } else {
                            console.log('[WebRTCService] 🚨 Signaling glare! Rolling back for', senderId);
                            await pc.setLocalDescription({ type: 'rollback' } as any);
                        }
                    }

                    await pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    
                    await callService.sendAnswer(answer, senderId);
                    await this.processPendingCandidates(senderId);
                    this.setState('connected');
                    break;
                }

                case 'answer': {
                    const pc = this.peerConnections.get(senderId);
                    if (pc && signal.payload) {
                        console.log(`[WebRTCService] ✅ Received answer from ${senderId}`);
                        await pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
                        await this.processPendingCandidates(senderId);
                        this.setState('connected');
                    }
                    break;
                }

                case 'ice-candidate': {
                    if (signal.payload) {
                        const pc = this.peerConnections.get(senderId);
                        const candidate = new RTCIceCandidate(signal.payload);
                        
                        if (pc && pc.remoteDescription) {
                            await pc.addIceCandidate(candidate);
                        } else {
                            if (!this.pendingCandidates.has(senderId)) {
                                this.pendingCandidates.set(senderId, []);
                            }
                            const queue = this.pendingCandidates.get(senderId)!;
                            if (queue.length < this.MAX_PENDING_CANDIDATES) {
                                queue.push(candidate);
                            }
                        }
                    }
                    break;
                }

                case 'call-end':
                    console.log(`[WebRTCService] 🏁 Remote user ${senderId} ended call`);
                    this.removePeer(senderId);
                    break;
            }
        } catch (error: any) {
            console.error(`[WebRTCService] ❌ Failed to handle ${signal.type} from ${senderId}:`, error);
        }
    }

    /**
     * End the current call
     */
    endCall(reason: string = 'manual'): void {
        console.log(`[WebRTCService] 🚨 endCall() called. Reason: ${reason}. Total Peers: ${this.peerConnections.size}`);

        // Guard: prevent double-end
        if (this.callState === 'ended' || this.callState === 'idle') {
            return;
        }

        // Mark state FIRST to prevent re-entrant calls
        this.setState('ended');

        // Stop local tracks
        if (this.localStream) {
            try {
                this.localStream.getTracks().forEach((track: any) => {
                    if (track && typeof track.stop === 'function') {
                        track.stop();
                    }
                });
            } catch (e) {
                console.warn('[WebRTCService] Error stopping local tracks:', e);
            }
            this.localStream = null;
        }

        // Close ALL peer connections
        this.peerConnections.forEach((pc, userId) => {
            console.log(`[WebRTCService] Closing connection to: ${userId}`);
            pc.close();
        });
        this.peerConnections.clear();

        // Stop all remote tracks
        this.remoteStreams.forEach((stream, userId) => {
            stream.getTracks().forEach(track => track.stop());
            this.broadcast('onRemoteStream', null, userId);
        });
        this.remoteStreams.clear();

        this.pendingCandidates.clear();
        this.partnerHasAccepted = false;
        this.pendingParticipants.clear();
        this.isInitiator = false;
        this.signalingRole = 'none';
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.connectionWatchdog) {
            clearTimeout(this.connectionWatchdog);
            this.connectionWatchdog = null;
        }
        
        if (this.offerRetryTimer) {
            clearTimeout(this.offerRetryTimer);
            this.offerRetryTimer = null;
        }
        this.offerRetryAttempts = 0;

        // STOP AUDIO SESSION
        void this.deactivateAudioSession(`end-call:${reason}`);

        // Reset state after short delay
        setTimeout(() => {
            if (this.listeners.length > 0 && this.callState === 'ended') {
                this.setState('idle');
            }
        }, 1000);
    }

    /**
     * Toggle mute on local audio
     */
    toggleMute(): boolean {
        if (this.localStream) {
            const audioTracks = this.localStream.getAudioTracks();
            if (audioTracks.length > 0) {
                const isCurrentlyEnabled = audioTracks[0].enabled;
                audioTracks.forEach((track: any) => {
                    track.enabled = !isCurrentlyEnabled;
                });
                return isCurrentlyEnabled; // Return true if now muted
            }
        }
        return false;
    }

    /**
     * Toggle local video
     */
    toggleVideo(): boolean {
        if (this.localStream && this.callType === 'video') {
            const videoTracks = this.localStream.getVideoTracks();
            if (videoTracks.length > 0) {
                const isCurrentlyEnabled = videoTracks[0].enabled;
                videoTracks.forEach((track: any) => {
                    track.enabled = !isCurrentlyEnabled;
                });
                return isCurrentlyEnabled; // Return true if video is now off
            }
        }
        return false;
    }

    /**
     * Switch call media mode between audio and video during an active call.
     * This keeps the same room/session and triggers renegotiation.
     */
    /**
     * Switch call media mode between audio and video during an active call.
     */
    async switchCallType(nextType: CallType): Promise<void> {
        if (nextType === this.callType) return;

        console.log(`[WebRTCService] Switching call mode: ${this.callType} -> ${nextType}`);
        this.callType = nextType;

        if (!this.hasManualAudioOutputOverride) {
            this.speakerEnabled = this.getPreferredSpeakerForCallType(nextType);
        }
        await this.setAudioOutput(this.speakerEnabled, false);

        // Update local stream
        await this.prepareCall(nextType);

        // Replace tracks in all peer connections
        if (this.peerConnections.size > 0 && this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            const audioTrack = this.localStream.getAudioTracks()[0];

            for (const [userId, pc] of this.peerConnections.entries()) {
                const senders = pc.getSenders();
                const videoSender = senders.find(s => s.track?.kind === 'video');
                const audioSender = senders.find(s => s.track?.kind === 'audio');

                if (videoSender && videoTrack) await videoSender.replaceTrack(videoTrack);
                if (audioSender && audioTrack) await audioSender.replaceTrack(audioTrack);
            }
        }
    }

    /**
     * Switch camera (front/back)
     */
    async switchCamera(): Promise<void> {
        if (this.localStream && this.callType === 'video') {
            const videoTrack = this.localStream.getVideoTracks()[0] as any;
            if (videoTrack && videoTrack._switchCamera) {
                videoTrack._switchCamera();
            }
        }
    }

    /**
     * Get current call state
     */
    getState(): CallState {
        return this.callState;
    }

    getSignalingState(): string {
        const firstPc = Array.from(this.peerConnections.values())[0];
        return (firstPc as any)?.signalingState || 'idle';
    }

    getIceConnectionState(): string {
        const firstPc = Array.from(this.peerConnections.values())[0];
        return (firstPc as any)?.iceConnectionState || 'idle';
    }

    // Private methods

    private async getMediaStream(): Promise<void> {
        let timer: NodeJS.Timeout | null = null;
        try {
            console.log('Getting media stream for', this.callType);

            if (!mediaDevices?.getUserMedia) {
                throw new Error(this.getAvailabilityError());
            }

            const micGranted = await this.ensureMicrophonePermission(true);
            if (!micGranted) {
                throw new Error('Microphone permission denied.');
            }
            
            // Mark as attempted so we don't try again and cause a double 8-second delay
            this.mediaStreamAttempted = true;

            const constraints: any = {
                audio: true,
                video: this.callType === 'video' ? {
                    facingMode: 'user',
                } : false,
            };

            const mediaPromise = (mediaDevices.getUserMedia(constraints) as Promise<MediaStream>).then(res => {
                if (timer) clearTimeout(timer);
                return res;
            });
            
            // INCREASE TIMEOUT: 5s is too short for some hardware/permissions prompts
            const timeoutPromise = new Promise<MediaStream>((_, reject) => {
                timer = setTimeout(() => reject(new Error('getUserMedia timed out after 15 seconds')), 15000);
            });

            this.localStream = await Promise.race([mediaPromise, timeoutPromise]);
            
            // CRITICAL: Explicitly enable tracks. Sometimes they are created in a disabled or muted state.
            this.localStream.getTracks().forEach(track => {
                track.enabled = true;
                console.log(`[WebRTCService] ✅ Local ${track.kind} track ready: ${track.id} (enabled: ${track.enabled})`);
            });
            
            // If we already have a PeerConnection, add these tracks NOW
            // If we have any existing PeerConnections, add these tracks to all of them
            if (this.peerConnections.size > 0 && this.localStream) {
                console.log(`[WebRTCService] Adding local tracks to ${this.peerConnections.size} existing PeerConnections`);
                for (const [userId, pc] of this.peerConnections.entries()) {
                    this.localStream.getTracks().forEach((track: any) => {
                        try {
                            pc.addTrack(track, this.localStream!);
                        } catch (e) {
                            console.warn(`[WebRTCService] Failed to add track to PC for ${userId}:`, e);
                        }
                    });

                    // Trigger re-negotiation if needed for this peer
                    if (pc.signalingState === 'stable') {
                        this.createOffer(userId).catch(e => console.warn(`Late offer failed for ${userId}:`, e));
                    }
                }
            }

            this.broadcast('onLocalStream', this.localStream);
            console.log('[WebRTCService] Local stream obtained successfully');

        } catch (error: any) {
            if (timer) clearTimeout(timer);
            const isSimulator = !Constants.isDevice;
            const errorMessage = String(error?.message || 'unknown');
            console.warn(`[WebRTCService] ⚠️ getMediaStream failed (Simulator=${isSimulator}):`, errorMessage);

            const lowerErrorMessage = errorMessage.toLowerCase();
            const isPermissionError =
                lowerErrorMessage.includes('permission') ||
                lowerErrorMessage.includes('denied') ||
                lowerErrorMessage.includes('not authorized');

            if (isPermissionError) {
                const message = 'Microphone permission denied. Please allow microphone access from settings.';
                this.broadcast('onError', message);
                throw new Error(message);
            }
            
            if (isSimulator && Platform.OS === 'ios') {
                console.log('[WebRTCService] 🛡️ Simulator detected. Proceeding with null local stream to avoid hardware crash.');
                this.localStream = null;
                this.broadcast('onLocalStream', null);
                // NOTE: We still allow the call to connect so signaling can be verified
                return;
            }
            
            // If the failure was a timeout or missing hardware, try audio-only fallback
            if ((Platform.OS === 'ios' || Platform.OS === 'android') && 
                (errorMessage.includes('found') || errorMessage.includes('time') || errorMessage.includes('device'))) {
                
                console.log('[WebRTCService] 🛡️ Proceeding with audio-only fallback stream...');
                let audioTimer: NodeJS.Timeout | null = null;
                try {
                    const audioOnlyPromise = (mediaDevices.getUserMedia({ audio: true, video: false }) as Promise<MediaStream>).then(res => {
                        if (audioTimer) clearTimeout(audioTimer);
                        return res;
                    });
                    const audioTimeout = new Promise<MediaStream>((_, reject) => {
                        audioTimer = setTimeout(() => reject(new Error('Audio-only fallback also timed out')), 10000);
                    });
                    
                    this.localStream = await Promise.race([audioOnlyPromise, audioTimeout]);
                    
                    // If we already have a PeerConnection, add these tracks NOW
                    if (this.peerConnections.size > 0 && this.localStream) {
                        for (const [userId, pc] of this.peerConnections.entries()) {
                            this.localStream.getTracks().forEach((track: any) => {
                                try { pc.addTrack(track, this.localStream!); } catch (e) {}
                            });
                        }
                    }

                    this.broadcast('onLocalStream', this.localStream);
                    return;
                } catch (e: any) {
                    if (audioTimer) clearTimeout(audioTimer);
                    console.warn('[WebRTCService] ⚠️ Audio fallback also failed or timed out:', e.message);
                }
            }
            
            // Critical fail-soft: even if NO media is available (Simulator/Busy Hardware), 
            // do NOT crash. Let signaling proceed so the call can at least connect.
            this.localStream = null;
            this.broadcast('onLocalStream', null);
            console.log('[WebRTCService] ⚠️ Proceeding with NO local stream. Signaling will still attempt to connect.');
        }
    }

    private broadcast(method: string, data: any, userId?: string): void {
        this.listeners.forEach((listener: any) => {
            if (typeof listener[method] === 'function') {
                listener[method](data, userId);
            }
        });
    }

    private startTrackMonitor(): void {
        this.stopTrackMonitoring();
        this.trackMonitorTimer = setInterval(() => {
            if (this.peerConnections.size === 0) return;
            
            for (const [userId, pc] of this.peerConnections.entries()) {
                if (pc.iceConnectionState === 'failed') {
                    console.warn(`[WebRTCService] 🚨 Connection failed for ${userId}`);
                }
            }
        }, 10000);
    }

    private startConnectionWatchdog(): void {
        if (this.connectionWatchdog) {
            clearTimeout(this.connectionWatchdog);
        }

        // PROACTIVE WATCHDOG: 8.5 seconds for first attempt to catch slow P2P gathering early
        this.connectionWatchdog = setTimeout(() => {
            this.connectionWatchdog = null;

            // Only act if we should be connected
            if (this.callState !== 'connecting' && this.callState !== 'ringing' && this.callState !== 'connected') {
                return;
            }

            const hasConnectedPeer = Array.from(this.peerConnections.values()).every((pc) => (
                pc.connectionState === 'connected'
                || pc.iceConnectionState === 'connected'
                || pc.iceConnectionState === 'completed'
            ));

            if (!hasConnectedPeer && this.peerConnections.size > 0) {
                console.warn('[WebRTCService] ⏰ Connection watchdog timeout — attempting defensive ICE restart');
                void this.attemptIceRestart().catch((error: any) => {
                    console.warn('[WebRTCService] Connection watchdog ICE restart failed:', error?.message || error);
                });
                
                // Keep watching (retry interval slightly shorter for recovery)
                this.startConnectionWatchdog();
            }
        }, this.reconnectAttempts === 0 ? 8500 : 6000);
    }

    private stopTrackMonitoring(): void {
        if (this.trackMonitorTimer) {
            clearInterval(this.trackMonitorTimer);
            this.trackMonitorTimer = null;
        }
    }

    private setState(state: CallState): void {
        if (this.callState === state) return;
        this.callState = state;
        console.log(`[WebRTCService] 🔄 State changed: ${state.toUpperCase()}`);
        this.broadcast('onStateChange', state);
    }

    private async createOffer(userId: string): Promise<void> {
        const pc = this.peerConnections.get(userId);
        if (!pc) return;

        try {
            console.log(`[WebRTCService] 🚀 Creating offer for user: ${userId}`);
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: this.callType === 'video'
            });
            await pc.setLocalDescription(offer);
            await callService.sendOffer(offer, userId);
        } catch (error: any) {
            console.error(`[WebRTCService] Failed to create offer for ${userId}:`, error);
        }
    }

    private async attemptIceRestart(): Promise<void> {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[WebRTCService] Max ICE restart attempts reached');
            this.endCall('reconnect-failed');
            return;
        }

        this.reconnectAttempts++;
        const shouldForceRelay = this.reconnectAttempts === 2;
        const shouldDestructiveReset = this.reconnectAttempts >= 3;
        
        console.log(`[WebRTCService] 🔄 Attempting ICE recovery stage ${this.reconnectAttempts}/${this.maxReconnectAttempts} | ForceRelay=${shouldForceRelay} | Destructive=${shouldDestructiveReset}`);
        
        for (const [userId, pc] of this.peerConnections.entries()) {
            try {
                if (shouldDestructiveReset) {
                    console.warn(`[WebRTCService] 🧨 Stage 4: DESTRUCTIVE RESET for peer ${userId}`);
                    await this.recreatePeerConnection(userId);
                    continue; // recreatePeerConnection handles the NEW offer
                }

                if (shouldForceRelay) {
                    console.log(`[WebRTCService] 🛡️ Stage 3: Escalating to FORCE-RELAY for ${userId}`);
                    const configs = await this.getPeerConnectionConfigs();
                    const relayConfig = configs.find(c => c.iceTransportPolicy === 'relay') || configs[0];
                    if (pc.setConfiguration) {
                        pc.setConfiguration(relayConfig);
                    }
                }
                
                const offer = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(offer);
                await callService.sendOffer(offer, userId);
            } catch (err: any) {
                console.warn(`[WebRTCService] ICE recovery stage ${this.reconnectAttempts} failed for ${userId}:`, err?.message);
                
                // If even the simple offer failed, try destructive next time
                if (this.reconnectAttempts < 5) {
                    this.connectionWatchdog = setTimeout(() => this.attemptIceRestart(), 2000) as any;
                }
            }
        }
    }

    private async recreatePeerConnection(userId: string): Promise<void> {
        console.log(`[WebRTCService] ♻️ Re-initializing connection for ${userId} from scratch...`);
        
        // 1. Teardown old connection
        const oldPc = this.peerConnections.get(userId);
        if (oldPc) {
            try {
                oldPc.close();
                this.peerConnections.delete(userId);
            } catch (e) {}
        }

        // 2. Clear state
        this.pendingParticipants.delete(userId);
        
        // 3. Create fresh connection with Aggressive Relay policy
        const configs = await this.getPeerConnectionConfigs();
        const aggressiveConfig = configs.find(c => c.iceTransportPolicy === 'relay') || configs[0];
        
        const newPc = await this.getOrCreatePeerConnection(userId, aggressiveConfig);
        
        // 4. Trigger fresh offer
        if (this.isInitiator) {
            console.log(`[WebRTCService] 🚀 Sending fresh offer after destructive reset to ${userId}`);
            const offer = await newPc.createOffer();
            await newPc.setLocalDescription(offer);
            await callService.sendOffer(offer, userId);
        }
    }

    cleanup(): void {
        this.listeners = [];
        this.stopTrackMonitoring();
        this.endCall('cleanup');
    }
}

export const webRTCService = new WebRTCService();
export type { CallState, CallType, WebRTCCallbacks };
