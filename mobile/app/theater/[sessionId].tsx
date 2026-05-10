import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    Pressable,
    StyleSheet,
    StatusBar,
    Platform,
    Alert,
    Linking,
    BackHandler,
    useWindowDimensions,
    KeyboardAvoidingView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
// Lazy-load react-native-youtube-iframe so a missing react-native-webview
// native module (e.g. dev client built before the package was added) does
// NOT crash the entire route tree at module-resolution time. Expo Router
// eagerly requires every route file at startup, so the import has to be
// guarded here for the rest of the app to keep working.
let YoutubePlayer: any = null;
let youtubePlayerLoadError: string | null = null;
try {
    YoutubePlayer = require('react-native-youtube-iframe').default;
} catch (e: any) {
    youtubePlayerLoadError =
        e?.message || 'react-native-youtube-iframe failed to load';
    console.warn('[TheaterScreen] YoutubePlayer not available:', youtubePlayerLoadError);
}
type YoutubeIframeRef = any;
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
    FadeIn,
    FadeOut,
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    withSpring,
    withRepeat,
    withSequence,
    withDelay,
    runOnJS,
    Easing,
} from 'react-native-reanimated';
import GlassView from '../../components/ui/GlassView';
import ProgressiveBlur from '../../components/chat/ProgressiveBlur';
import { supabase } from '../../config/supabase';
import { useApp } from '../../context/AppContext';
import { useTheater } from '../../context/TheaterContext';
import { SoulAvatar } from '../../components/SoulAvatar';
import TheaterChatOverlay from '../../components/theater/TheaterChatOverlay';
import ChatComposer, { type ChatComposerHandle } from '../../components/chat/ChatComposer';
import TheaterParticipantsOverlay from '../../components/theater/TheaterParticipantsOverlay';
import TheaterVideoPickerOverlay from '../../components/theater/TheaterVideoPickerOverlay';
import type { YouTubeSnippet } from '../../services/YouTubeService';
import { SUPPORT_SHARED_TRANSITIONS, SOUL_LIQUID_TRANSITION } from '../../constants/sharedTransitions';
import { getTheaterMorphOrigin, clearTheaterMorphOrigin } from '../../utils/theaterMorphOrigins';

const HEARTBEAT_INTERVAL_MS = 1500;
const SEEK_LOCK_MS = 3000;
const DRIFT_THRESHOLD_HEARTBEAT_MS = 700;
const DRIFT_THRESHOLD_SEEK_MS = 200;
const USER_INTENT_GUARD_MS = 30_000;
const PARTICIPANT_TILE_COMPACT_SIZE = 66;
const PARTICIPANT_TILE_GAP = 8;
const PARTICIPANT_TILE_EXPANDED_HORIZONTAL_PADDING = 6;
const PARTICIPANT_TILE_COMPACT_HORIZONTAL_PADDING = 8;
const PARTICIPANT_TILE_VERTICAL_PADDING = 4;
const PARTICIPANT_TILE_SWIPE_THRESHOLD = 18;
const PARTICIPANT_TILE_MORPH_SPRING = {
    damping: 30,
    stiffness: 220,
    mass: 0.85,
    overshootClamping: false,
} as const;

// Lazily load RTCView the same way call.tsx does so a missing native video
// view manager doesn't crash the screen — sync + chat overlay still work.
const videoRenderModules = (() => {
    try {
        const RTCViewModule = require('react-native-webrtc/lib/commonjs/RTCView');
        return { RTCView: RTCViewModule.default || RTCViewModule };
    } catch {
        return { RTCView: null };
    }
})();
const RTCView = videoRenderModules.RTCView as any;

const AnimatedImage = Animated.createAnimatedComponent(Image);

const formatTime = (ms: number): string => {
    if (!ms || ms < 0) return '00:00';
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m >= 60) {
        const h = Math.floor(m / 60);
        const rem = m % 60;
        return `${h.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const hexToRgba = (hex: string, alpha: number): string => {
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    return `rgba(${r},${g},${b},${alpha})`;
};

export default function TheaterScreen() {
    const params = useLocalSearchParams<{
        sessionId: string;
        chatId?: string;
        contactName?: string;
        messageId?: string;
        title?: string;
        mediaTitle?: string;
        channelTitle?: string;
        thumbnail?: string;
        youtubeVideoId?: string;
        isLocked?: string;
        isHost?: string;
        hostId?: string;
    }>();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const { activeTheme, currentUser, deleteMessage, updateMessage, contacts } = useApp() as any;
    const theater = useTheater();
    const accent = activeTheme?.primary || '#ff0080';

    console.log('[TheaterScreen] 🚀 Rendering TheaterScreen with new fixes (v2)');

    const sessionId = String(params.sessionId || '');
    const chatId = params.chatId ? String(params.chatId) : '';
    const contactName = params.contactName ? String(params.contactName) : '';
    const messageId = params.messageId ? String(params.messageId) : '';
    const sessionTitle = params.title || 'Theater Night';
    const isLocked = params.isLocked === '1' || params.isLocked === 'true';
    const isHost = params.isHost === '1' || params.isHost === 'true';

    // Video info starts from the params we were navigated with, but moves into
    // state so the in-theater picker can swap to a different YouTube video
    // without unmounting the screen — the broadcast tells both peers to load
    // the new videoId and reset position to 0.
    const [youtubeVideoId, setYoutubeVideoId] = useState<string | undefined>(params.youtubeVideoId);
    const [mediaTitle, setMediaTitle] = useState<string | undefined>(params.mediaTitle);
    const [channelTitle, setChannelTitle] = useState<string | undefined>(params.channelTitle);
    const [thumbnail, setThumbnail] = useState<string | undefined>(params.thumbnail);
    const [showVideoPicker, setShowVideoPicker] = useState(false);

    const playerRef = useRef<YoutubeIframeRef>(null);
    // Start paused so the user explicitly taps play. Auto-starting fails on
    // iOS WebViews without a user gesture (the iframe shows a "Watch on
    // YouTube" overlay instead of playing) and surprises users with sudden
    // audio. Remote sync still flips this to true when a host is already
    // playing — see the realtime sync handler below.
    const [isPlaying, setIsPlaying] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [showParticipants, setShowParticipants] = useState(false);
    const [embedError, setEmbedError] = useState<null | 'embed_not_allowed' | 'video_not_found' | 'other'>(null);
    const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const chatComposerRef = useRef<ChatComposerHandle | null>(null);

    // Card-to-fullscreen morph. originRect captures the chat card's screen
    // position the moment the user tapped Join (stashed by TheaterSessionCard
    // via measureInWindow). morphProgress drives the screen from that rect
    // (value 0) up to a full-bleed fullscreen layout (value 1).
    //
    // Tuned with a deliberately *slower, fully damped* spring so the user
    // actually sees the expansion play out — earlier configs settled in
    // ~250ms which read as a snap. This config takes ~620ms to settle,
    // never overshoots, and feels organic. Inner content also scales from
    // ~0.78 → 1.0 in lockstep so the expansion reads as a continuous
    // unfurl, not a clipped fragment that suddenly fills.
    const originRect = useMemo(() => getTheaterMorphOrigin(sessionId), [sessionId]);
    const morphProgress = useSharedValue(originRect ? 0 : 1);
    // contentVisibility is decoupled from the rect morph. During expand it
    // stays at 1 the entire time (so the IN animation is unchanged — user
    // confirmed it feels right). During shrink it animates 1→0 quickly so
    // the inner UI fades to a clean black rect BEFORE the rect itself has
    // fully shrunk — that hides the squashed/clipped layout that used to
    // appear when full-screen content was clipped to a card-sized box.
    const contentVisibility = useSharedValue(originRect ? 0 : 1);
    // Backdrop opacity is driven by its own shared value (decoupled from the
    // shrink progress) so on OUT we can fade the dimming layer FAST while the
    // rect itself takes its time deexpanding back to the card. Without this
    // the backdrop stayed half-opaque through most of the shrink, dimming the
    // chat behind and producing the "everything looks black" perception even
    // though the rect was already much smaller than the screen.
    const backdropOpacity = useSharedValue(originRect ? 0 : 1);
    const isClosingRef = useRef(false);
    const MORPH_IN_SPRING = useMemo(() => ({
        damping: 28,
        stiffness: 130,
        mass: 1.0,
        overshootClamping: false,
        restDisplacementThreshold: 0.001,
        restSpeedThreshold: 0.001,
    }), []);
    // Tuned so the rect deexpands in ~360ms — snappy enough to not feel like a
    // wait, slow enough that the user actually sees the fullscreen → card
    // shrink play out. Higher stiffness + lower mass than the IN spring
    // because deexpand reads better as a confident snap-back than a leisurely
    // settle.
    const MORPH_OUT_SPRING = useMemo(() => ({
        damping: 26,
        stiffness: 240,
        mass: 0.65,
        overshootClamping: true,
    }), []);
    useEffect(() => {
        if (!originRect) return;
        morphProgress.value = withSpring(1, MORPH_IN_SPRING);
        // Backdrop dims in alongside the spring (smoothstep-ish ramp via a
        // gentle ease-out) so the chat behind doesn't pop-dim instantly.
        backdropOpacity.value = withTiming(1, {
            duration: 360,
            easing: Easing.bezier(0.2, 0.8, 0.2, 1),
        });
        // Fade content in slightly after the rect starts growing so the user
        // sees the box unfurl first, then the UI materializes inside it.
        contentVisibility.value = withDelay(
            120,
            withTiming(1, { duration: 280, easing: Easing.bezier(0.2, 0.8, 0.2, 1) }),
        );
    }, [morphProgress, contentVisibility, backdropOpacity, originRect, MORPH_IN_SPRING]);
    const morphAnimatedStyle = useAnimatedStyle(() => {
        if (!originRect) return {};
        const p = morphProgress.value;
        return {
            position: 'absolute',
            left: originRect.x + (0 - originRect.x) * p,
            top: originRect.y + (0 - originRect.y) * p,
            width: originRect.width + (screenWidth - originRect.width) * p,
            height: originRect.height + (screenHeight - originRect.height) * p,
            borderRadius: 16 * (1 - p),
            overflow: 'hidden',
        };
    });
    const morphContentStyle = useAnimatedStyle(() => {
        if (!originRect) return {};
        // Scale the inner content alongside the box so the user sees the
        // entire theater UI expand uniformly, instead of a corner fragment
        // being progressively revealed by an enlarging clip mask. Opacity
        // is driven by the dedicated `contentVisibility` shared value so we
        // can fade it out *during shrink* before the rect fully collapses.
        const p = morphProgress.value;
        const scale = 0.78 + 0.22 * p;
        return { transform: [{ scale }], opacity: contentVisibility.value };
    });
    const morphBackdropStyle = useAnimatedStyle(() => {
        if (!originRect) return { opacity: 1 };
        return { opacity: backdropOpacity.value };
    });
    // Card-overlay layer (LIVE pill + footer w/ title + End/Join) sits inside
    // the morph rect above the thumbnail, opposite-fading to the theater UI.
    // While theater content is visible, overlays are hidden. As content fades
    // out during deexpand, these card overlays fade in — so the rect lands at
    // the card position visually identical to the real card, and when the
    // modal unmounts the handoff is invisible (no late "End/Join pop in").
    const cardOverlayStyle = useAnimatedStyle(() => {
        if (!originRect) return { opacity: 0 };
        return { opacity: 1 - contentVisibility.value };
    });
    const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
    const [participantTilesCollapsed, setParticipantTilesCollapsedState] = useState(false);
    const participantTilesCollapsedRef = useRef(false);
    const participantTilesMorph = useSharedValue(0);
    const participantTileTouchStartRef = useRef({ x: 0, y: 0 });
    const participantTileSwipeTriggeredRef = useRef(false);

    const handleAttachMenuToggle = useCallback((open: boolean) => {
        setIsAttachMenuOpen(open);
    }, []);

    const dismissAttachMenu = useCallback(() => {
        chatComposerRef.current?.dismissModals();
    }, []);

    const setParticipantTilesCollapsed = useCallback((collapsed: boolean) => {
        participantTilesCollapsedRef.current = collapsed;
        setParticipantTilesCollapsedState(collapsed);
        participantTilesMorph.value = withSpring(collapsed ? 1 : 0, PARTICIPANT_TILE_MORPH_SPRING);
    }, [participantTilesMorph]);

    const handleParticipantTilesTouchStart = useCallback((event: any) => {
        participantTileTouchStartRef.current = {
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY,
        };
        participantTileSwipeTriggeredRef.current = false;
    }, []);

    const handleParticipantTilesTouchMove = useCallback((event: any) => {
        if (participantTileSwipeTriggeredRef.current) return;
        const dx = event.nativeEvent.pageX - participantTileTouchStartRef.current.x;
        const dy = event.nativeEvent.pageY - participantTileTouchStartRef.current.y;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (absY < PARTICIPANT_TILE_SWIPE_THRESHOLD || absY < absX * 1.15) return;
        participantTileSwipeTriggeredRef.current = true;
        setParticipantTilesCollapsed(true);
    }, [setParticipantTilesCollapsed]);

    const handleParticipantTilesTouchEnd = useCallback(() => {
        if (!participantTilesCollapsedRef.current || participantTileSwipeTriggeredRef.current) return;
        setParticipantTilesCollapsed(false);
    }, [setParticipantTilesCollapsed]);

    // Sync state refs — kept outside React state so the heartbeat closure
    // and remote-event handler always read the current values.
    const positionRef = useRef(0);
    const isPlayingRef = useRef(false);
    const seekLockUntilRef = useRef(0);
    const userIntentRef = useRef<{ state: 'play' | 'pause'; at: number }>({ state: 'pause', at: 0 });
    const isApplyingRemoteRef = useRef(false);
    // The iframe may fire onChangeState('playing') a few moments after we
    // commanded pause (buffering recovery, Android WebView ignoring the
    // pauseVideo injection mid-buffer). Without enforcement, that callback
    // would call setIsPlaying(true) and silently undo the user's pause.
    // `desiredPlayingRef` is the canonical truth of what we WANT — it's
    // updated on every user toggle AND on every remote-apply, and any iframe
    // state event that contradicts it is gated. For pause specifically, we
    // also lay a black overlay on top of the iframe + mute the audio so the
    // user perceives a pause even if the embedded player keeps streaming
    // underneath.
    const desiredPlayingRef = useRef(false);
    // Holds the most recent remote state we received before the iframe was
    // ready to act on it. The videoLoaded effect drains this ref so a guest
    // who joined while the iframe was still loading still snaps to the host's
    // position instead of staying at 00:00.
    const pendingRemoteStateRef = useRef<{ positionMs: number; isPlaying: boolean; action?: string } | null>(null);
    const videoLoadedRef = useRef(false);
    // Mirror the current video metadata into a ref so the heartbeat closure
    // (set up once per session) can broadcast the LATEST videoId every tick.
    // Without this, when the host switches video via the picker, only the
    // single change_video broadcast carries the new id — if it gets dropped,
    // the guest is stuck on the old video forever. With it in heartbeats,
    // any drift between host/guest videoId self-heals within 1.5s.
    const currentVideoMetaRef = useRef<{
        videoId?: string; mediaTitle?: string; channelTitle?: string; thumbnail?: string;
    }>({});
    positionRef.current = position;
    isPlayingRef.current = isPlaying;
    videoLoadedRef.current = videoLoaded;
    currentVideoMetaRef.current = {
        videoId: youtubeVideoId,
        mediaTitle,
        channelTitle,
        thumbnail,
    };

    const livePulse = useSharedValue(1);
    useEffect(() => {
        livePulse.value = withRepeat(
            withSequence(
                withTiming(0.4, { duration: 800, easing: Easing.inOut(Easing.quad) }),
                withTiming(1, { duration: 800, easing: Easing.inOut(Easing.quad) }),
            ),
            -1,
            false,
        );
    }, [livePulse]);

    // Fallback: If onReady never fires (e.g. iOS WebView quirk), force load after 4s
    // so the user isn't stuck on the Loading screen forever.
    useEffect(() => {
        if (!youtubeVideoId) return;
        const t = setTimeout(() => {
            if (!videoLoadedRef.current) {
                console.log('[TheaterScreen] ⚠️ Forcing videoLoaded to true after timeout');
                setVideoLoaded(true);
            }
        }, 4000);
        return () => clearTimeout(t);
    }, [youtubeVideoId]);
    const livePulseStyle = useAnimatedStyle(() => ({ opacity: livePulse.value }));

    const posterOpacity = useSharedValue(1);
    const posterStyle = useAnimatedStyle(() => ({ opacity: posterOpacity.value }));

    useEffect(() => {
        if (videoLoaded && isPlaying) {
            posterOpacity.value = withTiming(0, { duration: 320 });
        }
    }, [videoLoaded, isPlaying, posterOpacity]);

    const scheduleControlsHide = useCallback(() => {
        if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3500);
    }, []);

    useEffect(() => {
        scheduleControlsHide();
        return () => {
            if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
        };
    }, [scheduleControlsHide]);

    // ─── Realtime sync: join session, broadcast (host) and apply remote state ───
    useEffect(() => {
        if (!sessionId) return;
        console.log(`[TheaterScreen] Joining session ${sessionId} (isHost=${isHost})`);

        theater.joinSession(sessionId);

        const unsubscribe = theater.subscribe((evt) => {
            // Late joiners ask peers for current state. The host responds with
            // their authoritative playback state so the guest can sync up.
            if (evt.type === 'sync_request') {
                if (isHost) {
                    console.log('[TheaterScreen] 📡 Responding to sync_request');
                    theater.broadcastState({
                        isPlaying: isPlayingRef.current,
                        positionMs: positionRef.current,
                        action: 'sync',
                    });
                }
                return;
            }
            // ping/pong are handled inside TheaterContext for clock calibration.
            if (evt.type !== 'update') return;

            // Host (or anyone authoritative) signaled the session is over —
            // bail immediately and let the cleanup effect tear everything down.
            if (evt.state.action === 'end') {
                if (router.canGoBack()) router.back();
                else router.replace('/' as any);
                return;
            }

            // VIDEO ID DRIFT HEAL: every heartbeat and update carries the
            // sender's current videoId. If our local id differs (likely
            // because we missed the change_video broadcast or joined late
            // from a stale chat bubble), pull ourselves to the sender's
            // videoId. Host-vs-guest doesn't matter — last-broadcast wins.
            const remoteVid = evt.state.videoMeta?.videoId;
            const localVid = currentVideoMetaRef.current.videoId;
            const isVideoDrift = remoteVid && localVid && remoteVid !== localVid;
            if (isVideoDrift && evt.state.action !== 'change_video') {
                console.log(`[TheaterScreen] 🔧 Video drift detected (local=${localVid}, remote=${remoteVid}) — healing`);
            }

            // Host picked a new video from the in-theater search OR we just
            // detected drift via heartbeat. Either way, swap the iframe's
            // videoId, reset to a clean "00:00, loading" state, and let the
            // next heartbeat drive playback.
            if ((evt.state.action === 'change_video' || isVideoDrift) && evt.state.videoMeta?.videoId) {
                const next = evt.state.videoMeta;
                console.log(`[TheaterScreen] 🔁 Remote change_video → ${next.videoId}`);
                setYoutubeVideoId(next.videoId);
                setMediaTitle(next.mediaTitle || undefined);
                setChannelTitle(next.channelTitle || undefined);
                setThumbnail(next.thumbnail || undefined);
                setEmbedError(null);
                setVideoLoaded(false);
                videoLoadedRef.current = false;
                setPosition(0);
                positionRef.current = 0;
                setDuration(0);
                pendingRemoteStateRef.current = null;
                seekLockUntilRef.current = Date.now() + SEEK_LOCK_MS;
                desiredPlayingRef.current = true;
                setIsPlaying(true);
                return;
            }

            const remote = evt.state;
            const now = Date.now();
            const isSeekLocked = now < seekLockUntilRef.current;
            if (isSeekLocked) {
                console.log('[TheaterScreen] ⏳ Ignoring remote (seek-locked)');
                return;
            }

            // Compensate for the time elapsed between sender and us.
            const targetPositionMs = Math.max(0, remote.position + Math.max(0, evt.driftMs));
            console.log(`[TheaterScreen] 📥 Remote: action=${remote.action} playing=${remote.isPlaying} pos=${Math.round(targetPositionMs)}ms drift=${Math.round(evt.driftMs)}ms`);

            // Always remember the latest remote state. If the iframe isn't
            // ready yet, the videoLoaded effect will drain this when the
            // player becomes controllable. Otherwise apply() runs straight
            // through and clears it.
            pendingRemoteStateRef.current = {
                positionMs: targetPositionMs,
                isPlaying: remote.isPlaying,
                action: remote.action,
            };

            const apply = async () => {
                if (!playerRef.current || !videoLoadedRef.current) {
                    console.log('[TheaterScreen] ⏳ Buffering remote state (player not ready)');
                    return;
                }
                isApplyingRemoteRef.current = true;
                try {
                    const localPos = positionRef.current;
                    const drift = Math.abs(localPos - targetPositionMs);
                    const action = remote.action || 'heartbeat';
                    const threshold =
                        action === 'seek'
                            ? DRIFT_THRESHOLD_SEEK_MS
                            : DRIFT_THRESHOLD_HEARTBEAT_MS;

                    if (action === 'seek' || action === 'sync' || drift > threshold) {
                        console.log(`[TheaterScreen] 🔄 Seeking to ${Math.round(targetPositionMs)}ms (drift=${Math.round(drift)}ms, action=${action})`);
                        try {
                            playerRef.current.seekTo(targetPositionMs / 1000, true);
                        } catch (e) {
                            console.warn('[TheaterScreen] seekTo failed:', e);
                        }
                    }

                    // User-intent guard: if user paused recently, don't snap back to play.
                    const userPausedRecently =
                        userIntentRef.current.state === 'pause' &&
                        now - userIntentRef.current.at < USER_INTENT_GUARD_MS;

                    if (remote.isPlaying && !isPlayingRef.current) {
                        if (!userPausedRecently) {
                            console.log('[TheaterScreen] ▶️ Remote says play');
                            desiredPlayingRef.current = true;
                            setIsPlaying(true);
                        }
                    } else if (!remote.isPlaying && isPlayingRef.current) {
                        console.log('[TheaterScreen] ⏸️ Remote says pause');
                        desiredPlayingRef.current = false;
                        setIsPlaying(false);
                    }

                    pendingRemoteStateRef.current = null;
                } finally {
                    setTimeout(() => { isApplyingRemoteRef.current = false; }, 250);
                }
            };
            void apply();
        });

        // BOTH host and guest should broadcast heartbeats so whichever side
        // enters first provides state to the other. The isHost flag only
        // controls whether we respond to sync_request and whether we show
        // the "End session" prompt on close.
        const heartbeatInterval = setInterval(() => {
            if (Date.now() < seekLockUntilRef.current) return;
            const meta = currentVideoMetaRef.current;
            theater.broadcastState({
                isPlaying: isPlayingRef.current,
                positionMs: positionRef.current,
                action: 'heartbeat',
                // Include videoMeta in every heartbeat so a guest stuck on a
                // stale video (e.g. missed a change_video broadcast) gets
                // pulled to the right videoId within 1.5s of the next tick.
                videoMeta: meta.videoId ? {
                    videoId: meta.videoId,
                    mediaTitle: meta.mediaTitle,
                    channelTitle: meta.channelTitle,
                    thumbnail: meta.thumbnail,
                } : undefined,
            });
        }, HEARTBEAT_INTERVAL_MS);

        // Guest also probes the host for sync after a short delay to handle
        // the case where the guest's channel finished subscribing after the
        // host's initial heartbeats were already sent.
        if (!isHost) {
            setTimeout(() => {
                console.log('[TheaterScreen] 📡 Guest requesting sync from host');
                theater.requestSync();
            }, 800);
        }

        return () => {
            clearInterval(heartbeatInterval);
            unsubscribe();
            theater.leaveSession(sessionId);
        };
    // We intentionally only depend on sessionId/isHost; theater methods are
    // stable across renders and re-subscribing on every render would thrash
    // the channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, isHost]);

    const markLocalInteraction = useCallback((intent: 'play' | 'pause') => {
        userIntentRef.current = { state: intent, at: Date.now() };
        seekLockUntilRef.current = Date.now() + SEEK_LOCK_MS;
    }, []);

    // Auto-enable mic the moment we land in the theater room — that's what
    // turns "watch together" into "watch and talk together" without making
    // the user hunt for the Mic button. Camera stays opt-in (most users
    // don't want their face on automatically). If the user has already
    // disabled the mic this session, we don't re-enable it on re-mount.
    const autoMicTriedRef = useRef(false);
    useEffect(() => {
        if (!sessionId) return;
        if (autoMicTriedRef.current) return;
        if (theater.roomState.micEnabled) return;
        if (!theater.isRoomAvailable) return;
        autoMicTriedRef.current = true;
        // Tiny delay so the realtime channel has a moment to SUBSCRIBE before
        // WebRTC presence broadcasts go out — otherwise the very first
        // `webrtc_presence:join` can race the channel join and get dropped.
        const t = setTimeout(() => {
            theater.enableMic().catch((err: any) => {
                console.warn('[TheaterScreen] auto-enableMic failed:', err?.message || err);
            });
        }, 600);
        return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    const togglePlayPause = useCallback(() => {
        // Read the live ref instead of the closure — closure can lag if the
        // user double-taps faster than React re-renders.
        const wasPlaying = isPlayingRef.current;
        const next = !wasPlaying;
        desiredPlayingRef.current = next;

        if (wasPlaying) {
            markLocalInteraction('pause');
            setIsPlaying(false);
            // Belt-and-suspenders for the YouTube embed audio that sometimes
            // ignores mute/volume props (especially Saregama-style music
            // videos with their own audio path). seekTo with allowSeekAhead
            // = false halts the player's buffer at the current position, which
            // forces an effective audio cut on top of the play prop change.
            try {
                playerRef.current?.seekTo(positionRef.current / 1000, false);
            } catch {}
            theater.broadcastState({
                isPlaying: false,
                positionMs: positionRef.current,
                action: 'pause',
            });
        } else {
            markLocalInteraction('play');
            setIsPlaying(true);
            // Resume kick. The pause path's `seekTo(pos, false)` halted the
            // iframe's buffer, so the play prop change alone can't restart
            // playback — YouTube treats `seekTo(samePos, true)` as a no-op.
            // Seeking to a SLIGHTLY different position (200ms back) forces
            // YouTube to do a real seek + buffer fetch, and per the IFrame
            // API "if seekTo is called from a non-paused state the player
            // plays the video" — combined with our play prop change firing
            // playVideo() right after, the iframe reliably resumes.
            try {
                const offsetMs = Math.max(0, positionRef.current - 200);
                playerRef.current?.seekTo(offsetMs / 1000, true);
            } catch {}
            theater.broadcastState({
                isPlaying: true,
                positionMs: positionRef.current,
                action: 'play',
            });
        }
        scheduleControlsHide();
    }, [markLocalInteraction, scheduleControlsHide, theater]);

    // YouTube iframe is controlled, so we poll its current playback time on a
    // short interval to keep positionRef hot for the heartbeat broadcaster
    // and the progress bar. 500ms is responsive enough without thrashing the
    // bridge.
    useEffect(() => {
        if (!videoLoaded) return;
        const interval = setInterval(async () => {
            try {
                const sec = await playerRef.current?.getCurrentTime();
                if (typeof sec === 'number' && sec >= 0) {
                    setPosition(Math.round(sec * 1000));
                }
            } catch {
                // Iframe not ready yet — try again next tick.
            }
        }, 500);
        return () => clearInterval(interval);
    }, [videoLoaded]);

    // The instant the iframe becomes controllable, drain any remote state we
    // buffered while it was still loading and ask the host for a fresh
    // snapshot — this is the fix for "guest taps Join but never syncs".
    //
    // For the HOST on iOS: `play={true}` was set before onReady, so the
    // YouTube iframe never saw the false→true transition — force it with a
    // quick toggle so playback actually starts (fixes "Loading…" stuck).
    useEffect(() => {
        if (!videoLoaded) return;
        console.log(`[TheaterScreen] ▶️ Player ready — kickstarting (isHost=${isHost})`);

        if (isHost) {
            // Force a play-state transition so the iframe registers it.
            setIsPlaying(false);
            setTimeout(() => setIsPlaying(true), 80);
        } else {
            const buffered = pendingRemoteStateRef.current;
            if (buffered && playerRef.current) {
                try {
                    playerRef.current.seekTo(buffered.positionMs / 1000, true);
                } catch (e) {
                    console.warn('[TheaterScreen] post-ready seekTo failed:', e);
                }
                setIsPlaying(buffered.isPlaying);
                pendingRemoteStateRef.current = null;
            } else {
                // No buffered state yet — force play and let sync catch up.
                setIsPlaying(false);
                setTimeout(() => setIsPlaying(true), 80);
            }
            // Re-probe the host even if we already drained — first heartbeat may
            // have hit before our channel finished SUBSCRIBING.
            try { theater.requestSync(); } catch {}
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoLoaded, isHost]);

    const handleTapVideo = useCallback(() => {
        setShowControls((prev) => {
            const next = !prev;
            if (next) scheduleControlsHide();
            return next;
        });
    }, [scheduleControlsHide]);

    const performLeave = useCallback(() => {
        const fallback = () => {
            if (router.canGoBack()) router.back();
            else router.replace('/' as any);
            clearTheaterMorphOrigin(sessionId);
        };
        if (!originRect || isClosingRef.current) {
            fallback();
            return;
        }
        isClosingRef.current = true;
        // The OUT is the visible mirror of the IN, but staged so the user
        // never sees a "big black box" eating the chat:
        //  1. Theater UI fades 1→0 (200ms) — morphInner dissolves, revealing
        //     the YouTube thumbnail floor that lives beneath it inside the
        //     rect. So the rect transitions from "theater UI" → "card-style
        //     thumbnail", not theater → black.
        //  2. Backdrop fades 1→0 (180ms) — the dimming layer over the chat
        //     clears fast, so the chat reads through cleanly long before the
        //     rect has finished shrinking.
        //  3. Spring shrinks the rect fullscreen → card-rect (~360ms) — this
        //     is the visible deexpand. Because the rect now contains the
        //     thumbnail (matching what the real card shows), the shrink
        //     reads as the theater morphing INTO the card, and router.back
        //     hands off seamlessly to the unmounted modal.
        contentVisibility.value = withTiming(0, {
            duration: 200,
            easing: Easing.bezier(0.4, 0.0, 0.7, 1),
        });
        // Backdrop fades fast (180ms) — before the rect has finished shrinking,
        // the chat behind is already fully visible. Without this, the backdrop
        // stayed dim through most of the shrink and made the whole screen
        // read as a "black mass" with the rect indistinguishable from chat bg.
        backdropOpacity.value = withTiming(0, {
            duration: 180,
            easing: Easing.bezier(0.4, 0.0, 0.7, 1),
        });
        morphProgress.value = withSpring(0, MORPH_OUT_SPRING, (finished) => {
            if (finished) runOnJS(fallback)();
        });
    }, [router, sessionId, originRect, morphProgress, contentVisibility, backdropOpacity, MORPH_OUT_SPRING]);

    const endForEveryone = useCallback(() => {
        console.log('[TheaterScreen] 🔴 Ending session for everyone');
        // 1. Tell everyone in the room to bail out NOW (faster than waiting for
        //    the DB row to round-trip via Realtime).
        try {
            theater.broadcastState({
                isPlaying: false,
                positionMs: positionRef.current,
                action: 'end',
            });
        } catch {}

        // 2. Update the local message's theater.status → 'ended' so the card
        //    immediately flips from LIVE+Join to the greyed-out ENDED state.
        //    This is much more reliable than deleting because:
        //    - The chat channel may be CLOSED so the delete broadcast never
        //      reaches the peer's realtime listener.
        //    - The local SQLite cache won't be cleared by a server-side delete
        //      until the next full re-sync.
        if (chatId && messageId && typeof updateMessage === 'function') {
            try {
                // Re-encode the theater meta with status='ended' into the
                // caption field so the change persists through DB round-trips.
                const { encodeTheaterMetaIntoCaption } = require('../../utils/theaterMetaCodec');
                const endedMeta = {
                    sessionId,
                    youtubeVideoId,
                    mediaTitle,
                    channelTitle,
                    status: 'ended',
                    hostId: params.hostId || currentUser?.id || '',
                    isLocked: isLocked,
                    participants: [],
                    viewerCount: 0,
                };
                const updatedCaption = encodeTheaterMetaIntoCaption(endedMeta);

                // Update local React state immediately
                void updateMessage(chatId, messageId, {
                    media: {
                        type: 'theater_session',
                        caption: updatedCaption,
                        theater: endedMeta,
                    },
                } as any);

                // Persist to Supabase so the other user picks it up on next
                // sync/re-hydrate — they might not be connected to the theater
                // channel or even the chat channel right now.
                void supabase
                    .from('messages')
                    .update({ media_caption: updatedCaption })
                    .eq('id', messageId)
                    .then(({ error }: any) => {
                        if (error) {
                            console.warn('[TheaterScreen] supabase caption update failed:', error);
                        } else {
                            console.log('[TheaterScreen] ✅ Supabase message marked as ended');
                        }
                    });

                // 3. Broadcast 'theater-ended' on the CHAT broadcast channel
                //    so the other user's card flips LIVE→ENDED in real time,
                //    even if they are NOT inside the theater screen.
                if (currentUser?.id && chatId) {
                    const normalizeId = (id: string) =>
                        id.startsWith('f00f00f0-0000-0000-0000-')
                            ? id
                            : id.toLowerCase();
                    const a = normalizeId(currentUser.id);
                    const b = normalizeId(chatId);
                    const [first, second] = [a, b].sort();
                    const chatChannelName = `chat:${first}_${second}`;

                    // Fire-and-forget: grab the existing channel if it's already
                    // subscribed (since chat/[id] is still on the stack), or
                    // create a temporary one to send the single broadcast.
                    const existingChannels = (supabase as any).getChannels?.() || [];
                    const existing = existingChannels.find?.((c: any) => c.topic === `realtime:${chatChannelName}`);
                    if (existing && existing.state === 'joined') {
                        existing.send({
                            type: 'broadcast',
                            event: 'theater-ended',
                            payload: { messageId, chatId, caption: updatedCaption },
                        }).catch(() => {});
                        console.log('[TheaterScreen] 📡 theater-ended sent on existing chat channel');
                    } else {
                        // No active chat channel — create a transient one on the
                        // same topic name. Supabase multiplexes by channel name so
                        // the peer's listener will receive this broadcast.
                        const tempCh = supabase.channel(chatChannelName, {
                            config: { broadcast: { self: false } },
                        });
                        tempCh.subscribe((status: string) => {
                            if (status === 'SUBSCRIBED') {
                                tempCh.send({
                                    type: 'broadcast',
                                    event: 'theater-ended',
                                    payload: { messageId, chatId, caption: updatedCaption },
                                }).catch(() => {});
                                console.log('[TheaterScreen] 📡 theater-ended sent on temp channel');
                                // Tear down after a small delay to ensure delivery
                                setTimeout(() => {
                                    try { supabase.removeChannel(tempCh); } catch {}
                                }, 500);
                            }
                        });
                    }
                }
            } catch (err) {
                console.warn('[TheaterScreen] endForEveryone status update failed:', err);
            }
        }

        // Defer the unmount briefly so the broadcast + channel.send actually
        // hit the wire before leaveSession tears the channel down. The morph
        // OUT itself runs ~360ms after this, giving the WS frame ~440ms total
        // to flush — ample headroom while keeping the perceived dismiss snappy.
        setTimeout(performLeave, 80);
    }, [chatId, messageId, performLeave, theater, updateMessage, sessionId, youtubeVideoId, mediaTitle, channelTitle, isLocked, currentUser?.id, params.hostId]);

    // Host swapped the playing video from the in-theater picker. Push the
    // change over the broadcast so the guest's iframe loads the new id at the
    // same moment, then re-encode the message's caption with the new meta so
    // anyone joining later (or re-mounting the screen) reads the right video.
    const handlePickVideo = useCallback((video: YouTubeSnippet) => {
        if (!isHost) return;
        if (!video?.videoId) return;
        if (video.videoId === youtubeVideoId) {
            setShowVideoPicker(false);
            return;
        }
        console.log(`[TheaterScreen] 🔁 Host change_video → ${video.videoId}`);

        // Update local UI immediately so host gets instant feedback.
        setShowVideoPicker(false);
        setYoutubeVideoId(video.videoId);
        setMediaTitle(video.title || undefined);
        setChannelTitle(video.channelTitle || undefined);
        setThumbnail(video.thumbnail || undefined);
        setEmbedError(null);
        setVideoLoaded(false);
        videoLoadedRef.current = false;
        setPosition(0);
        positionRef.current = 0;
        setDuration(0);
        pendingRemoteStateRef.current = null;
        seekLockUntilRef.current = Date.now() + SEEK_LOCK_MS;
        desiredPlayingRef.current = true;
        setIsPlaying(true);

        // Tell the guest to switch.
        try {
            theater.broadcastState({
                isPlaying: true,
                positionMs: 0,
                action: 'change_video',
                videoMeta: {
                    videoId: video.videoId,
                    mediaTitle: video.title,
                    channelTitle: video.channelTitle,
                    thumbnail: video.thumbnail,
                    durationSec: video.durationSec,
                },
            });
        } catch (e) {
            console.warn('[TheaterScreen] broadcast change_video failed:', e);
        }

        // Persist into the chat bubble so a late-joiner sees the latest video.
        if (chatId && messageId && typeof updateMessage === 'function') {
            try {
                const { encodeTheaterMetaIntoCaption } = require('../../utils/theaterMetaCodec');
                const nextMeta = {
                    sessionId,
                    youtubeVideoId: video.videoId,
                    mediaTitle: video.title,
                    channelTitle: video.channelTitle,
                    status: 'live' as const,
                    hostId: params.hostId || currentUser?.id || '',
                    isLocked,
                    participants: [params.hostId || currentUser?.id || ''],
                    viewerCount: Math.max(theater.viewers.length, 1),
                };
                const updatedCaption = encodeTheaterMetaIntoCaption(nextMeta);

                void updateMessage(chatId, messageId, {
                    media: {
                        type: 'theater_session',
                        url: video.videoId,
                        name: sessionTitle,
                        thumbnail: video.thumbnail,
                        duration: video.durationSec,
                        caption: updatedCaption,
                        theater: nextMeta,
                    },
                } as any);

                void supabase
                    .from('messages')
                    .update({
                        media_url: video.videoId,
                        media_thumbnail: video.thumbnail,
                        media_duration: video.durationSec,
                        media_caption: updatedCaption,
                    })
                    .eq('id', messageId)
                    .then(({ error }: any) => {
                        if (error) {
                            console.warn('[TheaterScreen] supabase video swap update failed:', error);
                        } else {
                            console.log('[TheaterScreen] ✅ Supabase message updated with new video');
                        }
                    });
            } catch (err) {
                console.warn('[TheaterScreen] handlePickVideo persist failed:', err);
            }
        }
    }, [
        isHost, youtubeVideoId, theater, chatId, messageId, updateMessage,
        sessionId, params.hostId, currentUser?.id, isLocked, sessionTitle,
    ]);

    const handleClose = useCallback(() => {
        if (!isHost) {
            performLeave();
            return;
        }
        // If the host already hit a fatal embed error, the session can never
        // play — skip the prompt and just end so the bubble flips to ENDED
        // instead of staying LIVE as a zombie that nobody can join.
        if (embedError) {
            endForEveryone();
            return;
        }
        Alert.alert(
            'End theater?',
            'Closing will end the room for everyone watching.',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'End session', style: 'destructive', onPress: endForEveryone },
            ],
            { cancelable: true },
        );
    }, [isHost, performLeave, endForEveryone, embedError]);

    // Android hardware back — route through handleClose so the host gets the
    // end-session prompt instead of silently abandoning a LIVE bubble. iOS
    // swipe-back is already disabled at the Stack level (gestureEnabled:
    // false) so this only matters on Android.
    useEffect(() => {
        if (Platform.OS !== 'android') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            handleClose();
            return true; // we handled it
        });
        return () => sub.remove();
    }, [handleClose]);

    const sharedTag = useMemo(() => `theater-poster-${sessionId}`, [sessionId]);
    const sharedCardTag = useMemo(() => `theater-card-${sessionId}`, [sessionId]);
    const useSharedTransition = SUPPORT_SHARED_TRANSITIONS && Platform.OS === 'ios';

    const progressPct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

    // Source the remote-tile from Supabase presence (`viewers`), not the
    // WebRTC participants Map — the latter is only populated when the native
    // webrtc module is loaded (i.e. dev client, NOT Expo Go) and would leave
    // the tile stuck on "Waiting…" even when the other user is genuinely in
    // the room. The WebRTC participant, if present, is layered on top so we
    // can still render their video stream / mic state when available.
    const remoteUserId = useMemo(() => {
        const others = (theater.viewers || []).filter((v) => v.userId !== currentUser?.id);
        return others[0]?.userId || null;
    }, [theater.viewers, currentUser?.id]);

    const remoteRtcParticipant = useMemo(() => {
        if (!remoteUserId) return null;
        return theater.roomState.participants.get(remoteUserId) || null;
    }, [theater.roomState.participants, remoteUserId]);

    const remoteContact = useMemo(() => {
        if (!remoteUserId) return null;
        return (contacts || []).find((x: any) => x.id === remoteUserId) || null;
    }, [contacts, remoteUserId]);

    const composerBottomInset = Platform.OS === 'ios'
        ? Math.max(insets.bottom, 34)
        : Math.max(insets.bottom, 8);
    const composerReservedHeight = composerBottomInset + 62;
    const showFloatingComposer = !!chatId && !showParticipants && !showVideoPicker;
    const expandedParticipantTileSize = Math.max(0, (screenWidth - (PARTICIPANT_TILE_EXPANDED_HORIZONTAL_PADDING * 2) - PARTICIPANT_TILE_GAP) / 2);
    const compactParticipantRowWidth =
        (PARTICIPANT_TILE_COMPACT_SIZE * 2)
        + PARTICIPANT_TILE_GAP
        + (PARTICIPANT_TILE_COMPACT_HORIZONTAL_PADDING * 2);
    const useTileSharedTransition = SUPPORT_SHARED_TRANSITIONS && Platform.OS === 'ios';

    const participantRowAnimatedStyle = useAnimatedStyle(() => {
        const p = participantTilesMorph.value;
        return {
            width: screenWidth + (compactParticipantRowWidth - screenWidth) * p,
            paddingHorizontal:
                PARTICIPANT_TILE_EXPANDED_HORIZONTAL_PADDING
                + (PARTICIPANT_TILE_COMPACT_HORIZONTAL_PADDING - PARTICIPANT_TILE_EXPANDED_HORIZONTAL_PADDING) * p,
            paddingVertical: PARTICIPANT_TILE_VERTICAL_PADDING,
        };
    }, [compactParticipantRowWidth, screenWidth]);

    const participantTileAnimatedStyle = useAnimatedStyle(() => {
        const p = participantTilesMorph.value;
        const size = expandedParticipantTileSize
            + (PARTICIPANT_TILE_COMPACT_SIZE - expandedParticipantTileSize) * p;
        return {
            width: size,
            height: size,
            borderRadius: 16 + (20 - 16) * p,
        };
    }, [expandedParticipantTileSize]);

    const participantTileContentAnimatedStyle = useAnimatedStyle(() => {
        const p = participantTilesMorph.value;
        return {
            transform: [{ scale: 1 - (0.22 * p) }],
        };
    });

    const participantTileControlsAnimatedStyle = useAnimatedStyle(() => {
        const p = participantTilesMorph.value;
        return {
            opacity: 1 - p,
            transform: [{ translateY: 10 * p }],
        };
    });

    return (
        <View style={styles.morphRoot} pointerEvents="box-none">
            {/* Backdrop fade — sits behind the morphing rect, fades in as the
                screen expands so the chat below is gradually masked. On exit
                it fades back out so the chat reads through during shrink. */}
            <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, morphBackdropStyle]}
            />
            <Animated.View style={[styles.root, morphAnimatedStyle]}>
            {/* Thumbnail floor — sits beneath the theater UI so when content
                fades during OUT, the rect reveals the same poster the chat
                card shows. The shrink then visually transforms the theater
                into the card (instead of into a solid black box that masks
                the chat bg). On IN it's hidden under the opaque morphInner
                until content fades in, so the IN read is unchanged. */}
            {originRect && thumbnail ? (
                <Image
                    source={{ uri: thumbnail }}
                    style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]}
                    contentFit="cover"
                    transition={0}
                    cachePolicy="memory-disk"
                    pointerEvents="none"
                />
            ) : null}
            {/* Card-overlay preview (LIVE pill + duration chip + title footer
                + End/Join). Opacity is opposite to contentVisibility, so it's
                fully visible exactly when the theater UI has faded out. The
                rect therefore lands at the card position already painted with
                what the real card shows — when the modal unmounts the takeover
                is invisible, no "End/Join pop-in" frame after the deexpand. */}
            {originRect ? (
                <Animated.View
                    pointerEvents="none"
                    style={[StyleSheet.absoluteFill, cardOverlayStyle]}
                >
                    <LinearGradient
                        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.05)', 'rgba(0,0,0,0.78)']}
                        locations={[0, 0.45, 1]}
                        style={StyleSheet.absoluteFill}
                        pointerEvents="none"
                    />
                    <View style={cardOverlayStyles.topRow}>
                        <View style={[cardOverlayStyles.livePill, { backgroundColor: accent }]}>
                            <View style={cardOverlayStyles.liveDot} />
                            <Text style={cardOverlayStyles.liveText}>LIVE</Text>
                        </View>
                    </View>
                    {duration > 0 ? (
                        <View style={cardOverlayStyles.durationChip}>
                            <MaterialIcons name="play-arrow" size={12} color="rgba(255,255,255,0.92)" />
                            <Text style={cardOverlayStyles.durationText}>
                                {(() => {
                                    const secs = Math.floor(duration / 1000);
                                    const m = Math.floor(secs / 60);
                                    const s = secs % 60;
                                    return `${m}:${s.toString().padStart(2, '0')}`;
                                })()}
                            </Text>
                        </View>
                    ) : null}
                    <View style={cardOverlayStyles.footer}>
                        <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                        <View style={cardOverlayStyles.footerInner}>
                            <View style={{ flex: 1, paddingRight: 8 }}>
                                <Text numberOfLines={1} style={cardOverlayStyles.title}>
                                    {sessionTitle}
                                </Text>
                                {mediaTitle ? (
                                    <Text numberOfLines={1} style={cardOverlayStyles.subtitle}>
                                        {mediaTitle}
                                    </Text>
                                ) : null}
                            </View>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                                {isHost ? (
                                    <View style={cardOverlayStyles.endActionPill}>
                                        <Text style={cardOverlayStyles.endActionText}>End</Text>
                                    </View>
                                ) : null}
                                <View style={[cardOverlayStyles.joinPill, { backgroundColor: accent }]}>
                                    <Text style={cardOverlayStyles.joinText}>Join</Text>
                                    <MaterialIcons name="arrow-forward" size={14} color="#fff" />
                                </View>
                            </View>
                        </View>
                    </View>
                </Animated.View>
            ) : null}
            <Animated.View style={[styles.morphInner, morphContentStyle]}>
            <StatusBar barStyle="light-content" />

            {/* Header (now in normal flow) */}
            <View style={[styles.header, { paddingTop: Math.max(insets.top, 14) + 4 }]} pointerEvents="box-none">
                <Pressable style={styles.headerCircleBtn} onPress={handleClose} hitSlop={10}>
                    <View style={styles.headerGlassFill} pointerEvents="none">
                        <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                    </View>
                    <MaterialIcons name="keyboard-arrow-down" size={28} color="#fff" />
                </Pressable>

                <View style={styles.headerCenter} pointerEvents="box-none">
                    <View style={styles.headerPill} pointerEvents="none">
                        <View style={styles.headerGlassFill} pointerEvents="none">
                            <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                        </View>
                        <Animated.View style={[styles.liveDotSmall, { backgroundColor: accent }, livePulseStyle]} />
                        <Text style={styles.headerPillText} numberOfLines={1}>Theater mode</Text>
                        {isLocked && (
                            <MaterialIcons name="lock" size={12} color="rgba(255,255,255,0.85)" />
                        )}
                    </View>
                </View>

                <View style={styles.headerRight}>
                    <Pressable
                        onPress={() => setShowParticipants((v) => !v)}
                        hitSlop={8}
                        style={styles.headerCircleBtn}
                    >
                        <View style={styles.headerGlassFill} pointerEvents="none">
                            <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                        </View>
                        <MaterialIcons name="people-alt" size={20} color="#fff" />
                        {theater.viewers.length > 0 ? (
                            <View style={[styles.headerActionBadge, { backgroundColor: accent }]}>
                                <Text style={styles.headerActionBadgeText}>
                                    {String(Math.max(theater.viewers.length, 1))}
                                </Text>
                            </View>
                        ) : null}
                    </Pressable>
                    {isHost ? (
                        <Pressable
                            onPress={() => setShowVideoPicker(true)}
                            hitSlop={8}
                            style={styles.headerCircleBtn}
                        >
                            <View style={styles.headerGlassFill} pointerEvents="none">
                                <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                            </View>
                            <MaterialIcons name="search" size={20} color="#fff" />
                        </Pressable>
                    ) : null}
                </View>
            </View>

            <Animated.View
                {...(useSharedTransition ? {
                    sharedTransitionTag: sharedCardTag,
                    sharedTransitionStyle: SOUL_LIQUID_TRANSITION,
                } : {})}
                collapsable={false}
                style={styles.videoArea}
            >
                <Pressable style={StyleSheet.absoluteFill} onPress={handleTapVideo}>
                {thumbnail ? (
                    useSharedTransition ? (
                        <AnimatedImage
                            sharedTransitionTag={sharedTag}
                            sharedTransitionStyle={SOUL_LIQUID_TRANSITION}
                            source={{ uri: thumbnail }}
                            style={[StyleSheet.absoluteFill, posterStyle]}
                            contentFit="cover"
                        />
                    ) : (
                        <AnimatedImage
                            source={{ uri: thumbnail }}
                            style={[StyleSheet.absoluteFill, posterStyle]}
                            contentFit="cover"
                        />
                    )
                ) : (
                    <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0a0a0a' }]} />
                )}

                {/* Iframe is mounted permanently so resume after pause is
                    instant (no WebView reload). Pause silence is achieved by
                    a layered defense: play={false} tells the player to pause,
                    mute + volume=0 cut audio, an explicit seekTo halts the
                    buffer, and the black overlay below masks any visual
                    leakage. When the user resumes, the same iframe just flips
                    play=true / mute=false and continues. */}
                {youtubeVideoId && YoutubePlayer ? (
                    <>
                        <View style={styles.youtubeWrap} pointerEvents="none">
                            <YoutubePlayer
                                ref={playerRef}
                                height={Math.round((screenWidth * 9) / 16)}
                                width={screenWidth}
                                videoId={youtubeVideoId}
                                play={isPlaying}
                                mute={!isPlaying}
                                volume={isPlaying ? 100 : 0}
                                onChangeState={(state: string) => {
                                    // Guard against re-entrancy: when we apply
                                    // remote state (setIsPlaying), YouTube fires
                                    // onChangeState back — without this guard it
                                    // creates a feedback loop that fights the sync.
                                    if (isApplyingRemoteRef.current) return;
                                    console.log(`[TheaterScreen] onChangeState: ${state}`);

                                    // INTENT GATE: if the iframe is playing
                                    // but we asked for pause, do NOT mirror
                                    // that into our React state — we'd kick
                                    // the user back into "isPlaying = true"
                                    // and the bottom button would show the
                                    // wrong icon. The iframe is already muted
                                    // (mute prop) and visually masked (black
                                    // overlay below) so the user perceives a
                                    // pause regardless of what the embedded
                                    // YouTube player decides to do internally.
                                    if (state === 'playing' && !desiredPlayingRef.current) {
                                        console.log('[TheaterScreen] ⏸️ Iframe playing despite pause intent — masking visually');
                                        // Re-issue the pause command exactly
                                        // once; if it sticks, great, if not,
                                        // the overlay handles UX. No toggle
                                        // loop because we don't bounce play
                                        // back to true.
                                        try {
                                            playerRef.current?.seekTo(positionRef.current / 1000, false);
                                        } catch {}
                                        return;
                                    }
                                    if (state === 'paused' && desiredPlayingRef.current) {
                                        // The iframe is in 'paused' state but
                                        // we just asked for play. This can
                                        // happen as a normal transition state
                                        // (paused → buffering → playing). Do
                                        // NOT flip our React state to false
                                        // here — that would fight the user's
                                        // play action and the play button
                                        // would be unresponsive. Instead just
                                        // ignore this event and let the
                                        // subsequent 'playing' event update
                                        // state naturally. If the iframe is
                                        // genuinely stuck in pause, the user
                                        // can tap play again or drag the seek
                                        // bar (which forces a real seek that
                                        // unsticks the player).
                                        return;
                                    }

                                    const isNativeInteraction = Date.now() > seekLockUntilRef.current;

                                    if (state === 'playing') {
                                        setIsPlaying(true);
                                        if (!videoLoaded) setVideoLoaded(true);
                                        if (isNativeInteraction && !isPlayingRef.current) {
                                            theater.broadcastState({
                                                isPlaying: true,
                                                positionMs: positionRef.current,
                                                action: 'play',
                                            });
                                        }
                                    } else if (state === 'paused') {
                                        setIsPlaying(false);
                                        if (isNativeInteraction && isPlayingRef.current) {
                                            theater.broadcastState({
                                                isPlaying: false,
                                                positionMs: positionRef.current,
                                                action: 'pause',
                                            });
                                        }
                                    } else if (state === 'ended') {
                                        setIsPlaying(false);
                                    } else if (state === 'buffering') {
                                        if (!videoLoaded) setVideoLoaded(true);
                                    }
                                }}
                                onReady={async () => {
                                    console.log('[TheaterScreen] ✅ YouTube player ready');
                                    setVideoLoaded(true);
                                    try {
                                        const dur = await playerRef.current?.getDuration();
                                        if (typeof dur === 'number' && dur > 0) {
                                            setDuration(Math.round(dur * 1000));
                                        }
                                    } catch (e) {
                                        console.warn('[TheaterScreen] getDuration failed:', e);
                                    }
                                }}
                                onError={(e: any) => {
                                    console.warn('[TheaterScreen] YouTube onError:', e);
                                    if (e === 'embed_not_allowed') setEmbedError('embed_not_allowed');
                                    else if (e === 'video_not_found') setEmbedError('video_not_found');
                                    else setEmbedError('other');
                                }}
                                initialPlayerParams={{
                                    controls: false,
                                    rel: false,
                                    preventFullScreen: true,
                                    // Critical for iOS inline playback with sound
                                    playsinline: 1,
                                    // Resume from where we paused. positionRef
                                    // holds the last polled time; on a fresh
                                    // theater open it's 0, on a resume it's
                                    // wherever the user paused.
                                    start: Math.max(0, Math.floor(positionRef.current / 1000)),
                                }}
                                // Forces a desktop user-agent on Android so the
                                // YouTube iframe doesn't gate playback on a user
                                // gesture — without this, guests on Android stay
                                // stuck on "Loading…" because onReady never fires.
                                forceAndroidAutoplay
                                webViewStyle={{ backgroundColor: 'transparent', opacity: 0.999 }}
                                webViewProps={{
                                    allowsInlineMediaPlayback: true,
                                    mediaPlaybackRequiresUserAction: false,
                                    javaScriptEnabled: true,
                                    domStorageEnabled: true,
                                    androidLayerType: 'hardware',
                                    mixedContentMode: 'always',
                                    // Allow audio without gesture on Android WebView
                                    allowsProtectedMedia: true,
                                    setSupportMultipleWindows: false,
                                }}
                            />
                        </View>
                        {Platform.OS === 'android' && (
                            <View style={StyleSheet.absoluteFill} pointerEvents="auto" />
                        )}
                        {/* Pause mask. The YouTube iframe sometimes ignores
                            pauseVideo() mid-buffer (especially Android
                            WebView), and we have no public API to force the
                            internal player into pause from JS. We side-step
                            that whole class of bug by laying an opaque
                            overlay on top of the video the moment the user
                            asks for pause — combined with mute={true} the
                            user gets a clean, instant pause UX even if the
                            embedded player keeps streaming silently
                            underneath. The poster + play button overlay
                            below already render on top, so the user can
                            still tap to resume. */}
                        {!isPlaying && videoLoaded && (
                            <Animated.View
                                entering={FadeIn.duration(120)}
                                exiting={FadeOut.duration(120)}
                                style={StyleSheet.absoluteFill}
                                pointerEvents="none"
                            >
                                <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
                                {thumbnail ? (
                                    <Image
                                        source={{ uri: thumbnail }}
                                        style={StyleSheet.absoluteFill}
                                        contentFit="cover"
                                    />
                                ) : null}
                                <LinearGradient
                                    colors={['rgba(0,0,0,0.45)', 'rgba(0,0,0,0.65)']}
                                    style={StyleSheet.absoluteFill}
                                    pointerEvents="none"
                                />
                            </Animated.View>
                        )}
                    </>
                ) : youtubeVideoId && !YoutubePlayer ? (
                    <View style={styles.playerErrorBox} pointerEvents="box-none">
                        <MaterialIcons name="error-outline" size={32} color="rgba(255,255,255,0.85)" style={{ marginBottom: 4 }} />
                        <Text style={styles.playerErrorTitle}>Native Player Unavailable</Text>
                        <Text style={styles.playerErrorBody}>
                            {Platform.OS === 'android'
                                ? 'Theater Mode requires a full build.\nRun: npx expo run:android\nto link the WebView native module.'
                                : 'Theater Mode requires a full build.\nRun: npx expo run:ios\nto link the WebView native module.'}
                        </Text>
                        <Pressable 
                            style={[styles.retryBtn, { backgroundColor: accent, marginTop: 8, alignSelf: 'center' }]}
                            onPress={() => router.back()}
                        >
                            <Text style={styles.retryBtnText}>Go Back</Text>
                        </Pressable>
                    </View>
                ) : null}

                {embedError ? (
                    <View style={[StyleSheet.absoluteFill, styles.loadingOverlay]}>
                        <View style={styles.embedErrorBox}>
                            <MaterialIcons
                                name={embedError === 'embed_not_allowed' ? 'block' : 'error-outline'}
                                size={36}
                                color="rgba(255,255,255,0.85)"
                            />
                            <Text style={styles.embedErrorTitle}>
                                {embedError === 'embed_not_allowed'
                                    ? "This video can't be played here"
                                    : embedError === 'video_not_found'
                                        ? 'Video unavailable'
                                        : "Couldn't load this video"}
                            </Text>
                            <Text style={styles.embedErrorBody}>
                                {embedError === 'embed_not_allowed'
                                    ? 'The uploader has disabled playback outside YouTube. Pick a different video to start a session.'
                                    : 'It may have been removed or made private. Try another video.'}
                            </Text>
                            <View style={styles.embedErrorActions}>
                                {youtubeVideoId ? (
                                    <Pressable
                                        style={[styles.embedErrorBtn, { backgroundColor: hexToRgba(accent, 0.95) }]}
                                        onPress={() => {
                                            const url = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
                                            Linking.openURL(url).catch((err) =>
                                                console.warn('[TheaterScreen] openURL failed:', err),
                                            );
                                        }}
                                    >
                                        <MaterialIcons name="open-in-new" size={14} color="#fff" />
                                        <Text style={styles.embedErrorBtnText}>Open in YouTube</Text>
                                    </Pressable>
                                ) : null}
                                <Pressable
                                    style={[styles.embedErrorBtn, styles.embedErrorBtnGhost]}
                                    onPress={handleClose}
                                >
                                    <Text style={styles.embedErrorBtnText}>Close</Text>
                                </Pressable>
                            </View>
                        </View>
                    </View>
                ) : !videoLoaded ? (
                    <View style={[StyleSheet.absoluteFill, styles.loadingOverlay]} pointerEvents="none">
                        <View style={[styles.loadingChip, { backgroundColor: hexToRgba(accent, 0.85) }]}>
                            <Animated.View style={[styles.loadingDot, livePulseStyle]} />
                            <Text style={styles.loadingText}>Loading…</Text>
                        </View>
                    </View>
                ) : null}

                <LinearGradient
                    colors={['rgba(0,0,0,0.45)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.55)']}
                    locations={[0, 0.18, 0.7, 1]}
                    style={StyleSheet.absoluteFill}
                    pointerEvents="none"
                />

                {/* Center play/pause button — overlays the video only. */}
                {showControls && videoLoaded && (
                    <Animated.View
                        entering={FadeIn.duration(180)}
                        exiting={FadeOut.duration(180)}
                        style={styles.centerPlayWrap}
                        pointerEvents="box-none"
                    >
                        <Pressable onPress={togglePlayPause} style={styles.centerPlayBtn}>
                            <GlassView intensity={50} tint="dark" style={StyleSheet.absoluteFill} />
                            <MaterialIcons
                                name={isPlaying ? 'pause' : 'play-arrow'}
                                size={36}
                                color="#fff"
                            />
                        </Pressable>
                    </Animated.View>
                )}

                {/* Progress bar — overlays the bottom edge of the video like
                    YouTube's player chrome. Visible only when controls are
                    shown and we have a known duration. The Pressable expands
                    the touch target via vertical padding so the visible track
                    can stay a hair-thin red line. */}
                {duration > 0 && showControls && (
                    <Animated.View
                        entering={FadeIn.duration(180)}
                        exiting={FadeOut.duration(180)}
                        style={styles.progressWrap}
                        pointerEvents="box-none"
                    >
                        <LinearGradient
                            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.5)']}
                            style={StyleSheet.absoluteFill}
                            pointerEvents="none"
                        />
                        <View style={styles.progressTimes}>
                            <Text style={styles.progressTimeText}>{formatTime(position)}</Text>
                            <Text style={styles.progressTimeTextDim}>{` / ${formatTime(duration)}`}</Text>
                        </View>
                        <Pressable
                            style={styles.progressBar}
                            onPress={(e) => {
                                const x = e.nativeEvent.locationX;
                                const pct = Math.max(0, Math.min(1, x / (screenWidth - 24)));
                                const seekMs = Math.round(pct * duration);
                                markLocalInteraction('play');
                                try {
                                    playerRef.current?.seekTo(seekMs / 1000, true);
                                } catch (err) {
                                    console.warn('[TheaterScreen] seek tap failed:', err);
                                }
                                setPosition(seekMs);
                                theater.broadcastState({
                                    isPlaying: isPlayingRef.current,
                                    positionMs: seekMs,
                                    action: 'seek',
                                });
                                scheduleControlsHide();
                            }}
                        >
                            <View style={styles.progressTrack}>
                                <View style={[styles.progressFill, { width: `${progressPct}%`, backgroundColor: accent }]} />
                                <View
                                    style={[
                                        styles.progressKnob,
                                        {
                                            left: `${progressPct}%`,
                                            backgroundColor: accent,
                                        },
                                    ]}
                                />
                            </View>
                        </Pressable>
                    </Animated.View>
                )}
                </Pressable>
            </Animated.View>

            {/* Two large participant tiles side-by-side, Rave-style. Left
                tile is the remote peer (or an empty placeholder if nobody
                has joined yet), right tile is the local user. Each tile
                shows a video stream when available and falls back to the
                avatar otherwise. */}
            <Animated.View
                style={[styles.participantRow, participantRowAnimatedStyle]}
                onTouchStart={handleParticipantTilesTouchStart}
                onTouchMove={handleParticipantTilesTouchMove}
                onTouchEnd={handleParticipantTilesTouchEnd}
            >
                {(() => {
                    const hasRemote = !!remoteUserId;
                    const showVideo = !!(remoteRtcParticipant?.stream && remoteRtcParticipant?.hasVideo && RTCView);
                    const hasAudio = !!remoteRtcParticipant?.hasAudio;
                    return (
                        <Animated.View
                            {...(useTileSharedTransition ? {
                                sharedTransitionTag: `theater-${sessionId}-remote-tile`,
                                sharedTransitionStyle: SOUL_LIQUID_TRANSITION,
                            } : {})}
                            entering={FadeIn.duration(220)}
                            style={[
                                styles.participantTileLarge,
                                participantTileAnimatedStyle,
                                !hasRemote && styles.participantTileLargeEmpty,
                                hasAudio && {
                                    borderColor: hexToRgba(accent, 0.7),
                                    borderWidth: 2,
                                },
                            ]}
                        >
                            {showVideo ? (
                                <RTCView
                                    streamURL={
                                        typeof remoteRtcParticipant!.stream.toURL === 'function'
                                            ? remoteRtcParticipant!.stream.toURL()
                                            : remoteRtcParticipant!.stream
                                    }
                                    style={styles.participantTileVideoLarge}
                                    objectFit="cover"
                                    zOrder={1}
                                />
                            ) : hasRemote ? (
                                <Animated.View style={participantTileContentAnimatedStyle}>
                                    <SoulAvatar
                                        uri={remoteContact?.avatar}
                                        localUri={remoteContact?.localAvatarUri}
                                        size={56}
                                        avatarType={remoteContact?.avatarType}
                                        teddyVariant={remoteContact?.teddyVariant}
                                    />
                                </Animated.View>
                            ) : (
                                <Animated.View style={[styles.participantEmptyContent, participantTileContentAnimatedStyle]}>
                                    <MaterialIcons name="person-outline" size={26} color="rgba(255,255,255,0.4)" />
                                    <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '600' }}>
                                        Waiting…
                                    </Text>
                                </Animated.View>
                            )}
                            {hasRemote && (
                                <Animated.View
                                    pointerEvents={participantTilesCollapsed ? 'none' : 'auto'}
                                    style={[styles.participantTileBottomBar, participantTileControlsAnimatedStyle]}
                                >
                                    <Text style={styles.participantTileName} numberOfLines={1}>
                                        {remoteContact?.name || 'Guest'}
                                    </Text>
                                    <View style={[
                                        styles.participantTileMicChip,
                                        { backgroundColor: hasAudio ? hexToRgba(accent, 0.95) : 'rgba(0,0,0,0.6)' },
                                    ]}>
                                        <MaterialIcons
                                            name={hasAudio ? 'mic' : 'mic-off'}
                                            size={11}
                                            color="#fff"
                                        />
                                    </View>
                                </Animated.View>
                            )}
                        </Animated.View>
                    );
                })()}

                {/* Local self-tile — mirrored video, mic + camera-switch. */}
                <Animated.View
                    {...(useTileSharedTransition ? {
                        sharedTransitionTag: `theater-${sessionId}-local-tile`,
                        sharedTransitionStyle: SOUL_LIQUID_TRANSITION,
                    } : {})}
                    entering={FadeIn.delay(120)}
                    style={[
                        styles.participantTileLarge,
                        participantTileAnimatedStyle,
                        theater.roomState.micEnabled && {
                            borderColor: hexToRgba(accent, 0.7),
                            borderWidth: 2,
                        },
                    ]}
                >
                    {theater.roomState.localStream && theater.roomState.cameraEnabled && RTCView ? (
                        <RTCView
                            streamURL={
                                typeof theater.roomState.localStream.toURL === 'function'
                                    ? theater.roomState.localStream.toURL()
                                    : theater.roomState.localStream
                            }
                            style={styles.participantTileVideoLarge}
                            objectFit="cover"
                            mirror
                            zOrder={2}
                        />
                    ) : (
                        <Animated.View style={participantTileContentAnimatedStyle}>
                            <SoulAvatar
                                uri={(currentUser as any)?.avatarUrl || (currentUser as any)?.avatar}
                                localUri={(currentUser as any)?.localAvatarUri}
                                size={56}
                                avatarType={(currentUser as any)?.avatarType}
                                teddyVariant={(currentUser as any)?.teddyVariant}
                                isOnline
                            />
                        </Animated.View>
                    )}
                    <Animated.View
                        pointerEvents={participantTilesCollapsed ? 'none' : 'auto'}
                        style={[styles.participantTileBottomBar, participantTileControlsAnimatedStyle]}
                    >
                        <Text style={styles.participantTileName} numberOfLines={1}>You</Text>
                        <Pressable
                            disabled={participantTilesCollapsed}
                            onPress={async () => {
                                try {
                                    if (theater.roomState.cameraEnabled) theater.disableCamera();
                                    else await theater.enableCamera();
                                } catch (e: any) {
                                    Alert.alert('Camera', e?.message || 'Could not enable camera.');
                                }
                            }}
                            hitSlop={6}
                            style={[
                                styles.participantTileMicChip,
                                { backgroundColor: theater.roomState.cameraEnabled ? hexToRgba(accent, 0.95) : 'rgba(0,0,0,0.6)' },
                            ]}
                        >
                            <MaterialIcons
                                name={theater.roomState.cameraEnabled ? 'videocam' : 'videocam-off'}
                                size={12}
                                color="#fff"
                            />
                        </Pressable>
                        <Pressable
                            disabled={participantTilesCollapsed}
                            onPress={async () => {
                                try {
                                    if (theater.roomState.micEnabled) theater.disableMic();
                                    else await theater.enableMic();
                                } catch (e: any) {
                                    Alert.alert('Mic', e?.message || 'Could not enable mic.');
                                }
                            }}
                            hitSlop={6}
                            style={[
                                styles.participantTileMicChip,
                                { backgroundColor: theater.roomState.micEnabled ? hexToRgba(accent, 0.95) : 'rgba(0,0,0,0.6)' },
                            ]}
                        >
                            <MaterialIcons
                                name={theater.roomState.micEnabled ? 'mic' : 'mic-off'}
                                size={12}
                                color="#fff"
                            />
                        </Pressable>
                    </Animated.View>
                    {theater.roomState.cameraEnabled && (
                        <Animated.View
                            pointerEvents={participantTilesCollapsed ? 'none' : 'auto'}
                            style={[styles.participantTileFlipChip, participantTileControlsAnimatedStyle]}
                        >
                            <Pressable
                                disabled={participantTilesCollapsed}
                                onPress={theater.switchCamera}
                                hitSlop={6}
                                style={styles.participantTileFlipPressable}
                            >
                                <MaterialIcons name="cameraswitch" size={14} color="rgba(255,255,255,0.92)" />
                            </Pressable>
                        </Animated.View>
                    )}
                </Animated.View>
            </Animated.View>

            {/* Theater chat — same data + MessageBubble as the main chat
                screen, rendered inline so it's always visible below the PIPs.
                Join taps on a theater bubble for a DIFFERENT session would
                navigate to that session; for the current session we just
                ignore (we're already inside it). End taps for the current
                session route through the existing endForEveryone flow. */}
            {chatId ? (
                <View style={[styles.inlineChatWrap, { paddingBottom: composerReservedHeight }]}>
                    <TheaterChatOverlay
                        chatId={chatId}
                        contactName={contactName}
                        accent={accent}
                        onClose={() => {}}
                        bottomInset={0}
                        style={styles.inlineChat}
                        inline
                        onMediaTap={(payload) => {
                            if (!payload?.theaterSession) return;
                            const tappedSessionId =
                                payload.sessionId || payload.theater?.sessionId;
                            if (tappedSessionId && tappedSessionId !== sessionId) {
                                // Different theater bubble tapped from inside an
                                // active theater — leave current and open the
                                // new one.
                                router.replace({
                                    pathname: '/theater/[sessionId]' as any,
                                    params: {
                                        sessionId: String(tappedSessionId),
                                        chatId,
                                        contactName,
                                        messageId: payload.messageId || '',
                                        title: payload.title || 'Theater Night',
                                        mediaTitle: payload.theater?.mediaTitle || '',
                                        channelTitle: payload.theater?.channelTitle || '',
                                        thumbnail: payload.thumbnail || '',
                                        youtubeVideoId: payload.youtubeVideoId || payload.theater?.youtubeVideoId || '',
                                        isLocked: payload.theater?.isLocked ? '1' : '0',
                                        isHost: payload.theater?.hostId === currentUser?.id ? '1' : '0',
                                        hostId: payload.theater?.hostId || '',
                                    },
                                });
                            }
                        }}
                        onTheaterEnd={(mid, _meta) => {
                            // Only the host of THIS session can end via the
                            // bubble; route through the existing flow which
                            // updates Supabase + broadcasts theater-ended.
                            if (mid === messageId && isHost) {
                                endForEveryone();
                            }
                        }}
                        composerRef={chatComposerRef}
                        skipComposer
                        listBottomPadding={12}
                    />
                    {/* Progressive blur overlay at the top of the chat — chat
                        messages scroll up into this fade zone so they bleed
                        smoothly under the participant tiles instead of getting
                        cut by a hard edge. pointerEvents: 'none' lets taps pass
                        through to the FlashList underneath. */}
                    <ProgressiveBlur
                        position="top"
                        height={70}
                        intensity={70}
                        tint="dark"
                    />
                </View>
            ) : null}

            {showFloatingComposer && isAttachMenuOpen ? (
                <Animated.View
                    entering={FadeIn.duration(120)}
                    exiting={FadeOut.duration(100)}
                    style={styles.attachMenuScrim}
                >
                    <Pressable
                        style={StyleSheet.absoluteFill}
                        onPress={dismissAttachMenu}
                    />
                </Animated.View>
            ) : null}

            {showFloatingComposer ? (
                <KeyboardAvoidingView
                    pointerEvents="box-none"
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                    keyboardVerticalOffset={0}
                    style={styles.floatingComposerLayer}
                >
                    <ChatComposer
                        ref={chatComposerRef}
                        messageKey={chatId}
                        accent={accent}
                        contactName={contactName}
                        enableTheaterAction
                        theaterActionSelected
                        style={[
                            styles.floatingComposer,
                            { marginBottom: composerBottomInset },
                        ]}
                        onAttachMenuToggle={handleAttachMenuToggle}
                    />
                </KeyboardAvoidingView>
            ) : null}

            {showParticipants ? (
                <TheaterParticipantsOverlay
                    accent={accent}
                    hostId={params.hostId ? String(params.hostId) : undefined}
                    participants={theater.roomState.participants}
                    viewers={theater.viewers}
                    micEnabled={theater.roomState.micEnabled}
                    cameraEnabled={theater.roomState.cameraEnabled}
                    onClose={() => setShowParticipants(false)}
                    bottomInset={Math.max(insets.bottom, 18)}
                />
            ) : null}

            {showVideoPicker && isHost ? (
                <TheaterVideoPickerOverlay
                    accent={accent}
                    currentVideoId={youtubeVideoId}
                    onPick={handlePickVideo}
                    onClose={() => setShowVideoPicker(false)}
                    bottomInset={Math.max(insets.bottom, 18)}
                />
            ) : null}
            </Animated.View>
            </Animated.View>
        </View>
    );
}

const styles = StyleSheet.create({
    morphRoot: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    morphInner: {
        flex: 1,
        backgroundColor: '#000',
    },
    root: {
        flex: 1,
        backgroundColor: '#000',
    },
    // Video occupies a 16:9 strip below the header. Participant row picks up
    // the remaining vertical space below it. This is the Rave-style layout
    // where video and participants are stacked, not overlaid.
    videoArea: {
        width: '100%',
        aspectRatio: 16 / 9,
        backgroundColor: '#000',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
    },
    // PIPs are a compact row right under the video — small enough that the
    // theater chat takes most of the remaining vertical space, large enough
    // that you can still see a face / mic indicator at a glance.
    participantRow: {
        flexDirection: 'row',
        alignSelf: 'flex-start',
        gap: PARTICIPANT_TILE_GAP,
        overflow: 'visible',
    },
    participantTileLarge: {
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: 'rgba(255,255,255,0.04)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
    },
    participantTileLargeEmpty: {
        opacity: 0.55,
    },
    participantTileVideoLarge: {
        width: '100%',
        height: '100%',
    },
    participantEmptyContent: {
        alignItems: 'center',
        gap: 4,
    },
    participantTileBottomBar: {
        position: 'absolute',
        left: 8,
        right: 8,
        bottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    participantTileName: {
        color: 'rgba(255,255,255,0.92)',
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.1,
        flexShrink: 1,
    },
    participantTileMicChip: {
        width: 22,
        height: 22,
        borderRadius: 11,
        alignItems: 'center',
        justifyContent: 'center',
    },
    participantTileFlipChip: {
        position: 'absolute',
        top: 8,
        right: 8,
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.55)',
    },
    participantTileFlipPressable: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // The chat lives directly under the PIPs and grabs the rest of the
    // vertical space (flex: 1). The TheaterChatOverlay component is reused
    // but rendered inline (not as a sliding modal), so we strip its absolute
    // backdrop styles via the `style` override below.
    inlineChatWrap: {
        flex: 1,
        backgroundColor: '#000',
        // Intentionally NOT overflow:'hidden' — when ChatComposer's attach
        // menu opens it extends ~340px upward and we want it (plus the dim
        // scrim) to rise OVER the participant tiles, not get clipped.
    },
    inlineChat: {
        position: 'relative',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'transparent',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: 'rgba(255,255,255,0.08)',
    },
    attachMenuScrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.66)',
        zIndex: 200,
        elevation: 200,
    },
    floatingComposerLayer: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
        zIndex: 220,
        elevation: 220,
    },
    floatingComposer: {
        paddingHorizontal: 8,
        paddingTop: 8,
        backgroundColor: 'transparent',
    },
    youtubeWrap: {
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    playerErrorBox: {
        alignSelf: 'center',
        maxWidth: 320,
        marginHorizontal: 24,
        padding: 18,
        borderRadius: 14,
        backgroundColor: 'rgba(255,80,80,0.14)',
        borderWidth: 1,
        borderColor: 'rgba(255,80,80,0.32)',
        alignItems: 'center',
        gap: 10,
    },
    playerErrorTitle: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '700',
        letterSpacing: 0.1,
        textAlign: 'center',
    },
    playerErrorBody: {
        color: 'rgba(255,255,255,0.78)',
        fontSize: 12,
        lineHeight: 17,
        textAlign: 'center',
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    loadingOverlay: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    loadingChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 20,
    },
    loadingText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.4,
    },
    embedErrorBox: {
        maxWidth: 320,
        marginHorizontal: 32,
        padding: 22,
        borderRadius: 18,
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        alignItems: 'center',
        gap: 10,
    },
    embedErrorTitle: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '700',
        textAlign: 'center',
        letterSpacing: 0.1,
    },
    embedErrorBody: {
        color: 'rgba(255,255,255,0.72)',
        fontSize: 12.5,
        lineHeight: 18,
        textAlign: 'center',
    },
    embedErrorActions: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 6,
    },
    embedErrorBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 14,
    },
    embedErrorBtnGhost: {
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.14)',
    },
    embedErrorBtnText: {
        color: '#fff',
        fontSize: 12.5,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingBottom: 10,
        gap: 10,
    },
    headerCircleBtn: {
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.18)',
    },
    headerGlassFill: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.28)',
    },
    headerCenter: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 6,
    },
    headerPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.18)',
        overflow: 'hidden',
        maxWidth: '100%',
    },
    headerPillText: {
        color: '#fff',
        fontSize: 14.5,
        fontWeight: '700',
        letterSpacing: 0.2,
        flexShrink: 1,
    },
    liveDotSmall: {
        width: 7,
        height: 7,
        borderRadius: 3.5,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    headerActionBadge: {
        position: 'absolute',
        top: 2,
        right: 2,
        minWidth: 14,
        height: 14,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
        borderWidth: 1.5,
        borderColor: '#000',
    },
    headerActionBadgeText: {
        color: '#fff',
        fontSize: 9,
        fontWeight: '800',
    },
    loadingDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#fff',
    },
    participantStack: {
        position: 'absolute',
        right: 12,
        top: '38%',
        gap: 8,
    },
    participantTile: {
        width: 60,
        height: 80,
        borderRadius: 14,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    participantVideo: {
        width: '100%',
        height: '100%',
    },
    participantFallback: {
        flex: 1,
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
    },
    flipChip: {
        position: 'absolute',
        top: 4,
        left: 4,
        width: 22,
        height: 22,
        borderRadius: 11,
        alignItems: 'center',
        justifyContent: 'center',
    },
    micChip: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: '#000',
    },
    centerPlayWrap: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    centerPlayBtn: {
        width: 76,
        height: 76,
        borderRadius: 38,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.18)',
    },
    progressWrap: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingHorizontal: 12,
        paddingTop: 22,
        paddingBottom: 8,
    },
    // YouTube-style: thin 2px track, the Pressable wrapper expands the touch
    // target via vertical padding while the visible track stays a hair-thin
    // line. The red fill + small scrubber knob mirrors YouTube's chrome.
    progressBar: {
        paddingVertical: 8,
        marginVertical: -8,
        justifyContent: 'center',
    },
    progressTrack: {
        height: 2,
        borderRadius: 1,
        backgroundColor: 'rgba(255,255,255,0.28)',
        overflow: 'visible',
        position: 'relative',
    },
    progressFill: {
        height: '100%',
        borderRadius: 1,
        position: 'absolute',
        left: 0,
        top: 0,
    },
    progressKnob: {
        position: 'absolute',
        top: -4,
        width: 10,
        height: 10,
        borderRadius: 5,
        marginLeft: -5,
    },
    progressTimes: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 6,
        marginLeft: 2,
    },
    progressTimeText: {
        color: '#fff',
        fontSize: 11,
        fontWeight: '600',
        letterSpacing: 0.2,
    },
    progressTimeTextDim: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 11,
        fontWeight: '500',
        letterSpacing: 0.2,
    },
    chatPreviewSheet: {
        position: 'absolute',
        left: 14,
        right: 14,
        borderRadius: 18,
        padding: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
    },
    chatPreviewHandle: {
        alignSelf: 'center',
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: 'rgba(255,255,255,0.25)',
        marginBottom: 10,
    },
    chatPreviewTitle: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '700',
        marginBottom: 6,
    },
    chatPreviewBody: {
        color: 'rgba(255,255,255,0.72)',
        fontSize: 12.5,
        lineHeight: 18,
    },
    retryBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 14,
    },
    retryBtnText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
});

// Mirrors TheaterSessionCard's overlay styles. Kept inline (not imported) so
// the morph rect can render the card's visual layer at any rect size during
// the deexpand without depending on the card component's prop surface.
const cardOverlayStyles = StyleSheet.create({
    topRow: {
        position: 'absolute',
        top: 10,
        left: 10,
        right: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    livePill: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 10,
        gap: 5,
    },
    liveDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#fff',
    },
    liveText: {
        color: '#fff',
        fontSize: 10,
        fontWeight: '800',
        letterSpacing: 0.8,
    },
    durationChip: {
        position: 'absolute',
        top: 10,
        right: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 9,
        backgroundColor: 'rgba(0,0,0,0.55)',
    },
    durationText: {
        color: 'rgba(255,255,255,0.92)',
        fontSize: 10.5,
        fontWeight: '700',
        letterSpacing: 0.3,
    },
    footer: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 56,
        overflow: 'hidden',
    },
    footerInner: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
    },
    title: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '700',
        letterSpacing: 0.1,
    },
    subtitle: {
        color: 'rgba(255,255,255,0.72)',
        fontSize: 11.5,
        fontWeight: '500',
        marginTop: 2,
    },
    joinPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 14,
    },
    joinText: {
        color: '#fff',
        fontSize: 12.5,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
    endActionPill: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(255,59,48,0.3)',
    },
    endActionText: {
        color: '#ff3b30',
        fontSize: 12.5,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
});
