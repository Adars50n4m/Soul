import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react';
import { Platform, AppState, Alert } from 'react-native';
import { supabase, LEGACY_TO_UUID } from '../config/supabase';
import { authService, AvatarType } from '../services/AuthService';
import { offlineService, getDb } from '../services/LocalDBService';
import { notificationService } from '../services/NotificationService';
import { proxySupabaseUrl } from '../config/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { soulFolderService } from '../services/SoulFolderService';

export type PrivacyValue = 'everyone' | 'contacts' | 'nobody';

export interface PrivacySettings {
    lastSeen: PrivacyValue;
    profilePhoto: PrivacyValue;
    status: PrivacyValue;
    readReceipts: boolean;
}

export const DEFAULT_PRIVACY: PrivacySettings = {
    lastSeen: 'everyone',
    profilePhoto: 'everyone',
    status: 'everyone',
    readReceipts: true,
};

// AvatarType imported from AuthService
export type TeddyVariant = 'boy' | 'girl';

export interface User {
    id: string;
    name: string;
    avatar: string;
    avatarType: AvatarType;
    teddyVariant?: TeddyVariant;
    bio: string;
    username?: string;
    birthdate?: string;
    lastUsernameChange?: string;
    note?: string;
    noteTimestamp?: string;
    country?: string;
    countryCode?: string;
    isSuperUser?: boolean;
}

interface AuthContextType {
    currentUser: User | null;
    isLoggedIn: boolean;
    isReady: boolean;
    login: (username: string, password: string) => Promise<boolean>;
    setSession: (userId: string) => Promise<void>;
    logout: () => Promise<void>;
    updateProfile: (updates: Partial<User>) => Promise<void>;
    changeUsername: (newUsername: string) => Promise<{ success: boolean; error?: string }>;
    refreshProfile: (userId: string) => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [currentUser, setCurrentUser] = useState<User | null>(null);
    const [isReady, setIsReady] = useState(false);
    const [deviceSessionId, setDeviceSessionId] = useState<string | null>(null);
    const [sessionError, setSessionError] = useState<string | null>(null);
    const currentUserRef = useRef<User | null>(null);
    const deviceSessionIdRef = useRef<string | null>(null);
    const isInitializingRef = useRef(true);
    const suppressMismatchUntilRef = useRef(0);

    useEffect(() => {
        deviceSessionIdRef.current = deviceSessionId;
    }, [deviceSessionId]);

    useEffect(() => {
        currentUserRef.current = currentUser;
    }, [currentUser]);

    const isSyncingRef = useRef(false);
    const syncQueueRef = useRef<string | null>(null);

    const isSuperUser = useCallback((userId?: string | null): boolean => {
        if (!userId) return false;
        return userId === LEGACY_TO_UUID['shri']
            || userId === LEGACY_TO_UUID['hari']
            || userId.startsWith('f00f00f0-0000-0000-0000-00000000000');
    }, []);

    const getSuperUserProfile = useCallback((userId?: string | null): User | null => {
        if (userId === LEGACY_TO_UUID['shri']) {
            return {
                id: userId,
                name: 'Shri',
                username: 'shri',
                avatar: '',
                avatarType: 'teddy',
                teddyVariant: 'boy',
                bio: 'SoulSync Founder | Jai Shree Ram',
                isSuperUser: true,
            };
        }

        if (userId === LEGACY_TO_UUID['hari']) {
            return {
                id: userId,
                name: 'Hari',
                username: 'hari',
                avatar: '',
                avatarType: 'teddy',
                teddyVariant: 'boy',
                bio: 'SoulSync Dev | Om Namah Shivay',
                isSuperUser: true,
            };
        }

        return null;
    }, []);

    const synchronizeSession = useCallback(async (userId: string) => {
        // Mutex: prevent concurrent sync calls from racing
        if (isSyncingRef.current) {
            console.log('[AuthContext] Sync already in progress, queuing:', userId);
            syncQueueRef.current = userId;
            return;
        }
        isSyncingRef.current = true;

        try {
            console.log('[AuthContext] Synchronizing session for:', userId);
            // Session Management: Generate local device session ID immediately.
            let localSessionId = await AsyncStorage.getItem('ss_device_session_id');
            if (!localSessionId) {
                localSessionId = `soul_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                await AsyncStorage.setItem('ss_device_session_id', localSessionId);
            }
            setDeviceSessionId(localSessionId);

            const bypassBase = getSuperUserProfile(userId);
            if (bypassBase) {
                console.log('[AuthContext] Initializing super user from bypass base:', bypassBase.username);
                setCurrentUser(bypassBase);
            }

            let profileTimeoutId: ReturnType<typeof setTimeout> | undefined;
            const profile = await Promise.race([
                authService.getProfile(userId),
                new Promise<null>((resolve) => {
                    profileTimeoutId = setTimeout(() => {
                        profileTimeoutId = undefined;
                        console.warn('[AuthContext] getProfile timed out');
                        resolve(null);
                    }, 5000);
                })
            ]).finally(() => {
                if (profileTimeoutId) clearTimeout(profileTimeoutId);
            });

            const rawName = profile?.displayName || '';
             
            const getProperName = () => {
                if (rawName && !rawName.startsWith('user_')) return rawName;
                if (profile?.username && !profile.username.startsWith('user_')) return profile.username;
                return profile?.username || rawName || 'User';
            };

            const shouldPersistRemoteSession = !!profile;
            if (shouldPersistRemoteSession) {
                // Set a 10s cooldown to prevent Realtime from triggering a mismatch on our own update
                suppressMismatchUntilRef.current = Date.now() + 10000;
                
                void (async () => {
                    try {
                        const { error } = await supabase
                            .from('profiles')
                            .update({ active_session_id: localSessionId })
                            .eq('id', userId);

                        if (error) {
                            console.warn('[AuthContext] Failed to persist active_session_id:', error.message);
                        }
                    } catch (err) {
                        console.warn('[AuthContext] Failed to persist active_session_id:', err);
                    }
                })();
            }

            if (profile) {
                const userObj: User = {
                    id: profile.id,
                    name: getProperName(),
                    username: profile.username,
                    avatar: proxySupabaseUrl(profile.avatarUrl) || '',
                    avatarType: profile.avatarType || 'default',
                    bio: profile.bio || '',
                    birthdate: profile.birthdate || undefined,
                    lastUsernameChange: profile.lastUsernameChange || undefined,
                    note: profile.note,
                    noteTimestamp: profile.note_timestamp,
                    country: profile.country || undefined,
                    countryCode: profile.countryCode || undefined,
                    isSuperUser: isSuperUser(userId)
                };
                setCurrentUser(userObj);
                await AsyncStorage.setItem('ss_current_user', userId);
                await AsyncStorage.setItem('ss_cached_user_profile', JSON.stringify(userObj));
                await AsyncStorage.setItem('ss_cached_user_profile_at', String(Date.now()));
            } else {
                const cachedProfileRaw = await AsyncStorage.getItem('ss_cached_user_profile');
                if (cachedProfileRaw) {
                    try {
                        const cachedProfile = JSON.parse(cachedProfileRaw) as User;
                        if (cachedProfile?.id === userId) {
                            console.warn('[AuthContext] Profile lookup failed, restoring cached profile for:', userId);
                            setCurrentUser(cachedProfile);
                            await AsyncStorage.setItem('ss_current_user', userId);
                        }
                    } catch (parseError) {
                        console.warn('[AuthContext] Failed to parse cached profile during sync fallback:', parseError);
                    }
                }
            }

            // Sync Push Token for reliable remote notifications
            if (userId) {
                notificationService.getPushToken().then(async (token) => {
                    if (token) {
                        console.log('[AuthContext] Syncing push token:', token);
                        // Update profile fallback columns
                        await supabase
                            .from('profiles')
                            .update({ 
                                push_token: token,
                                push_platform: Platform.OS
                            })
                            .eq('id', userId);
                        
                        // Update dedicated push_tokens table
                        await supabase
                            .from('push_tokens')
                            .upsert({
                                user_id: userId,
                                token: token,
                                platform: Platform.OS,
                                token_type: 'fcm', // Use FCM for standard expo tokens
                                updated_at: new Date().toISOString()
                            }, { onConflict: 'user_id, platform' });
                    }
                }).catch(err => console.warn('[AuthContext] Push token sync failed:', err));
            }
        } catch (e) {
            console.error('[AuthContext] Session synchronization failed:', e);
        } finally {
            isSyncingRef.current = false;
            // Process queued sync if another call came in while we were busy
            const queued = syncQueueRef.current;
            if (queued) {
                syncQueueRef.current = null;
                synchronizeSession(queued);
            }
        }
    }, [getSuperUserProfile]);

    const synchronizeSessionWithTimeout = useCallback(async (userId: string, timeoutMs = 7000) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            synchronizeSession(userId),
            new Promise((resolve) => {
                timeoutId = setTimeout(() => {
                    timeoutId = undefined;
                    console.warn(`[AuthContext] synchronizeSession timed out after ${timeoutMs}ms for ${userId}`);
                    resolve(null);
                }, timeoutMs);
            })
        ]).finally(() => {
            if (timeoutId) clearTimeout(timeoutId);
        });
    }, [synchronizeSession]);

    const refreshProfile = useCallback(async (userId: string) => {
        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', userId)
                .single();

            if (data && !error) {
                setCurrentUser(prev => prev ? {
                    ...prev,
                    name: data.name || prev.name,
                    avatar: proxySupabaseUrl(data.avatar_url) || prev.avatar,
                    avatarType: data.avatar_type || prev.avatarType,
                    teddyVariant: data.teddy_variant || prev.teddyVariant,
                    bio: data.bio || prev.bio,
                    note: data.note || prev.note,
                    noteTimestamp: data.note_timestamp || prev.noteTimestamp,
                    country: data.country || prev.country,
                    countryCode: data.country_code || prev.countryCode
                } : null);
            }
        } catch (e) {
            console.warn('[AuthContext] refreshProfile exception:', e);
        }
    }, []);

    useEffect(() => {
        const handleAuthChange = async (event: string, session: any) => {
            console.log(`[AuthContext] Auth event: ${event}`);
            if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
                const user = session?.user;
                if (user) {
                    const cachedUserId = await AsyncStorage.getItem('ss_current_user');
                    if (isSuperUser(cachedUserId) && !isSuperUser(user.id)) {
                        console.log('[AuthContext] Ignoring Supabase auth event while super user cache is active');
                        return;
                    }
                    await synchronizeSession(user.id);
                }
            } else if (event === 'SIGNED_OUT') {
                // Super users (shri/hari) survive Supabase SIGNED_OUT events
                // (e.g. token refresh failures, network issues). They are only
                // cleared via the explicit logout() call.
                const cachedUserId = await AsyncStorage.getItem('ss_current_user');
                if (isSuperUser(cachedUserId)) {
                    console.log('[AuthContext] Super user preserved through SIGNED_OUT event');
                    return;
                }

                setCurrentUser(null);
                await AsyncStorage.multiRemove(['ss_current_user', 'ss_cached_user_profile', 'ss_cached_user_profile_at', 'ss_device_session_id']);
            } else if (event === 'PASSWORD_RECOVERY') {
                router.push('/forgot-password?mode=reset' as any);
            }
        };

        const { data: { subscription } } = authService.onAuthStateChange(handleAuthChange);

        // Wire up token refresh monitoring so expired sessions are detected
        const cleanupTokenRefresh = authService.setupTokenRefreshHandling((isRefreshing) => {
            if (!isRefreshing) {
                console.log('[AuthContext] Token refresh cycle complete');
            }
        });

        return () => {
            subscription.unsubscribe();
            cleanupTokenRefresh();
        };
    }, [isSuperUser, synchronizeSession]);

    useEffect(() => {
        let isMounted = true;
        let sessionTimeoutId: ReturnType<typeof setTimeout> | undefined;
        let dbTimeoutId: ReturnType<typeof setTimeout> | undefined;

        console.log('[AuthContext] Initializing - checking session...');
        
        const startInit = Date.now();
        
        // --- NEW: Block until Database Migration is verified (with 5s fail-safe) ---
        // --- REFINED: Optimistic Initialization Flow ---
        const runInit = async () => {
            try {
                // 1. PHASE ZERO: Optimistic Cache Restore
                // We do this BEFORE the DB phase to have a user object ready as early as possible.
                const [cachedUserId, cachedProfileRaw] = await Promise.all([
                    AsyncStorage.getItem('ss_current_user'),
                    AsyncStorage.getItem('ss_cached_user_profile')
                ]);

                if (cachedUserId && cachedProfileRaw) {
                    try {
                        const parsed = JSON.parse(cachedProfileRaw) as User;
                        if (parsed?.id === cachedUserId) {
                            console.log('[AuthContext] Phase 0: Optimistically restored user from cache:', parsed.username);
                            setCurrentUser(parsed);
                        }
                    } catch (e) {
                        console.warn('[AuthContext] Failed to parse optimistic cache:', e);
                    }
                }

                // 2. PHASE ONE: Database Connectivity
                const dbPromise = (async () => {
                    await getDb();
                    if (dbTimeoutId) {
                        clearTimeout(dbTimeoutId);
                        dbTimeoutId = undefined;
                    }
                    if (isMounted) console.log(`[AuthContext] Database ready after ${Date.now() - startInit}ms`);
                    return true;
                })();

                const dbTimeout = new Promise<boolean>((resolve) => {
                    dbTimeoutId = setTimeout(() => {
                        dbTimeoutId = undefined;
                        console.warn(`[AuthContext] Database initialization HUNG after 2s - continuing to UI`);
                        resolve(false);
                    }, 2000);
                });

                await Promise.race([dbPromise, dbTimeout]);
                if (!isMounted) return;

                // 3. PHASE TWO: Session Verification
                if (cachedUserId && isSuperUser(cachedUserId)) {
                    console.log('[AuthContext] Prioritizing cached super user during boot:', cachedUserId);
                    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
                    await synchronizeSessionWithTimeout(cachedUserId, 3000);
                    return;
                }
                
                const sessionPromise = (async () => {
                    const res = await supabase.auth.getSession();
                    if (sessionTimeoutId) {
                        clearTimeout(sessionTimeoutId);
                        sessionTimeoutId = undefined;
                    }
                    return res;
                })();

                const sessionTimeout = new Promise<null>((resolve) => {
                    sessionTimeoutId = setTimeout(() => {
                        sessionTimeoutId = undefined;
                        // INCREASED: 5s for Android reliability
                        console.warn(`[AuthContext] Session check TIMED OUT after 5s, relying on cache...`);
                        resolve(null);
                    }, 5000);
                });

                const sessionResult = await Promise.race([sessionPromise, sessionTimeout]);
                if (!isMounted) return;

                console.log(`[AuthContext] Initialization complete after ${Date.now() - startInit}ms.`);
                
                // If timeout fired (null), we've already set the user optimistically if available
                if (!sessionResult) {
                    // We stay in ready state; if we have a cached user, they stay logged in (offline mode)
                    setIsReady(true);
                    return;
                }

                const session = (sessionResult as any)?.data?.session;
                const error = (sessionResult as any)?.error;

                if (error) {
                    console.error('[AuthContext] Session check error:', error);
                    // On error, we keep the optimistic user if it exists, hoping for recovery
                    setIsReady(true);
                    return;
                }

                if (session) {
                    console.log('[AuthContext] Session verified, syncing profile for:', session.user.id);
                    await synchronizeSessionWithTimeout(session.user.id);
                } else {
                    console.log('[AuthContext] No active session found.');
                    if (!isMounted) return;

                    // If we had an optimistic user but no session, verify if we should keep them
                    if (cachedUserId) {
                        console.log('[AuthContext] Optimistic user exists but session is missing, attempting refresh...');
                        const refreshed = await authService.refreshSession();
                        const { data: refreshedSessionData } = await supabase.auth.getSession();
                        const refreshedUserId = refreshedSessionData.session?.user?.id;

                        if (refreshed && refreshedUserId) {
                            console.log('[AuthContext] Session restored via refresh. Syncing profile for:', refreshedUserId);
                            await synchronizeSessionWithTimeout(refreshedUserId);
                        } else {
                            // Truly logged out or session expired
                            const cachedAt = Number(await AsyncStorage.getItem('ss_cached_user_profile_at') || '0');
                            const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

                            if (currentUserRef.current && (Date.now() - cachedAt) < CACHE_TTL_MS) {
                                console.warn('[AuthContext] Session expired, keeping cached profile for offline use');
                                // Keep currentUser as is (already set in Phase 0)
                            } else {
                                console.warn('[AuthContext] Auth cache stale or invalid. Clearing.');
                                setCurrentUser(null);
                                await AsyncStorage.multiRemove(['ss_current_user', 'ss_cached_user_profile']);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('[AuthContext] Initialization exception:', err);
            } finally {
                if (isMounted) {
                    console.log(`[AuthContext] Reached ready state (total init time: ${Date.now() - startInit}ms)`);
                    setIsReady(true);
                    isInitializingRef.current = false;
                }
            }
        };

        runInit();

        return () => {
            isMounted = false;
            if (dbTimeoutId) clearTimeout(dbTimeoutId);
            if (sessionTimeoutId) clearTimeout(sessionTimeoutId);
        };
    }, [isSuperUser, synchronizeSession, synchronizeSessionWithTimeout]);

    const login = useCallback(async (emailOrUsername: string, password: string): Promise<boolean> => {
        const result = await authService.signInWithPassword(emailOrUsername, password);
        
        // FIX: If bypass login succeeds, manually sync session since onAuthStateChange won't trigger
        if (result.success && result.user) {
            const userId = result.user.id;
            if (userId === LEGACY_TO_UUID['shri'] || userId === LEGACY_TO_UUID['hari']) {
                await synchronizeSession(userId);
            }
        }
        
        return result.success;
    }, [synchronizeSession]);

    const setSession = useCallback(async (userId: string) => {
        await synchronizeSession(userId);
    }, [synchronizeSession]);

    const logout = useCallback(async () => {
        console.log('[AuthContext] Logging out, clearing local data...');
        try {
            // First clear the local SQLite database to prevent pollution
            await offlineService.clearDatabase();
            
            // Clear local media cache
            await soulFolderService.clearAllMedia();
        } catch (e) {
            console.error('[AuthContext] Failed to clear local data during logout:', e);
        }

        await authService.signOut();
        setCurrentUser(null);
        await AsyncStorage.multiRemove([
            'ss_current_user',
            'ss_cached_user_profile',
            'ss_cached_user_profile_at',
            'ss_device_session_id',
            'ss_last_contact_sync',
            'ss_pinned_chats',
            'ss_muted_chats',
            'auth_token_expired',
        ]);
        router.replace('/login');
    }, []);

    const updateProfile = useCallback(async (updates: Partial<User>) => {
        if (!currentUser) return;
        try {
            const { error } = await supabase
                .from('profiles')
                .update({
                    name: updates.name,
                    bio: updates.bio,
                    avatar_url: updates.avatar,
                    avatar_type: updates.avatarType,
                    teddy_variant: updates.teddyVariant,
                    birthdate: updates.birthdate,
                    country: updates.country,
                    country_code: updates.countryCode,
                    note: updates.note,
                    note_timestamp: updates.noteTimestamp
                })
                .eq('id', currentUser.id);

            if (!error) {
                await refreshProfile(currentUser.id);
            } else {
                console.error('[AuthContext] Update profile error:', error);
                throw error;
            }
        } catch (e: any) {
            console.error('[AuthContext] Update profile failed:', e);
            throw e;
        }
    }, [currentUser, refreshProfile]);

    const changeUsername = useCallback(async (newUsername: string) => {
        if (!currentUser) return { success: false, error: 'Not logged in' };
        const result = await authService.updateUsername(currentUser.id, newUsername);
        if (result.success) {
            await refreshProfile(currentUser.id);
        }
        return result;
    }, [currentUser, refreshProfile]);

    // ── SESSION MONITORING: Real-time logout if logged in elsewhere ──────────
    useEffect(() => {
        if (!currentUser?.id) return;

        console.log('[AuthContext] Subscribing to session monitor for:', currentUser.id);
        
        const channel = supabase
            .channel(`session_monitor_${currentUser.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'profiles',
                    filter: `id=eq.${currentUser.id}`
                },
                (payload) => {
                    // Superusers are exempt from session enforcement rules
                    if (isSuperUser(currentUser.id)) {
                        return;
                    }

                    const newSessionId = payload.new.active_session_id;
                    const currentLocalId = deviceSessionIdRef.current;
                    
                    console.log(`[AuthContext] Session update detected: DB=${newSessionId}, Local=${currentLocalId}`);
                    
                    if (isInitializingRef.current || Date.now() < suppressMismatchUntilRef.current) {
                        console.log('[AuthContext] Mismatch check suppressed (Initializing or Cooldown)');
                        return;
                    }

                    if (newSessionId && currentLocalId && newSessionId !== currentLocalId) {
                        console.warn('[AuthContext] Session mismatch detected! Scheduling alert...');
                        setSessionError('You have been logged out because you logged in on another device.');
                    }
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [currentUser?.id, logout]);

    // ── SESSION MONITORING: Re-validate on App Resume ────────────────────────
    useEffect(() => {
        const subscription = AppState.addEventListener('change', async (nextAppState) => {
            if (nextAppState === 'active' && currentUser?.id) {
                console.log('[AuthContext] App active, re-validating session...');
                try {
                    const { data, error } = await supabase
                        .from('profiles')
                        .select('active_session_id')
                        .eq('id', currentUser.id)
                        .single();
                    
                    if (data && !error) {
                        const dbSessionId = data.active_session_id;
                        const localId = deviceSessionIdRef.current;
                        
                        if (isInitializingRef.current || Date.now() < suppressMismatchUntilRef.current) {
                            console.log('[AuthContext] Foreground mismatch check suppressed');
                            return;
                        }

                        if (dbSessionId && localId && dbSessionId !== localId) {
                            console.warn('[AuthContext] Foreground session mismatch! Scheduling alert...');
                            setSessionError('Account active on another device. Please log in again to continue.');
                        }
                    }
                } catch (e) {
                    console.warn('[AuthContext] Foreground session check failed:', e);
                }
            }
        });

        return () => subscription.remove();
    }, [currentUser?.id, logout]);

    useEffect(() => {
        if (sessionError) {
            Alert.alert(
                'Session Mismatch',
                sessionError,
                [{ text: 'OK', onPress: () => {
                    setSessionError(null);
                    logout();
                }}],
                { cancelable: false }
            );
        }
    }, [sessionError, logout]);

    const value = {
        currentUser,
        isLoggedIn: !!currentUser,
        isReady,
        login,
        setSession,
        logout,
        updateProfile,
        changeUsername,
        refreshProfile
    };

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
