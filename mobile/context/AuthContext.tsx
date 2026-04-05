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

    useEffect(() => {
        deviceSessionIdRef.current = deviceSessionId;
    }, [deviceSessionId]);

    useEffect(() => {
        currentUserRef.current = currentUser;
    }, [currentUser]);

    const isSyncingRef = useRef(false);
    const syncQueueRef = useRef<string | null>(null);

    const isDeveloperBypassId = useCallback((userId?: string | null): boolean => {
        if (!userId) return false;
        return userId === LEGACY_TO_UUID['shri']
            || userId === LEGACY_TO_UUID['hari']
            || userId.startsWith('f00f00f0-0000-0000-0000-00000000000');
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
            // Add timeout to prevent hanging
            const profile = await Promise.race([
                authService.getProfile(userId),
                new Promise<null>((resolve) => setTimeout(() => {
                    console.warn('[AuthContext] getProfile timed out');
                    resolve(null);
                }, 5000))
            ]);
            // Session Management: Generate and sync device session ID
            let localSessionId = await AsyncStorage.getItem('ss_device_session_id');
            if (!localSessionId) {
                localSessionId = `soul_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                await AsyncStorage.setItem('ss_device_session_id', localSessionId);
            }
            setDeviceSessionId(localSessionId);

            // Update profile with the new session ID
            await supabase
                .from('profiles')
                .update({ active_session_id: localSessionId })
                .eq('id', userId);

            if (profile) {
                const userObj: User = {
                    id: profile.id,
                    name: profile.displayName || profile.username || 'User',
                    username: profile.username,
                    avatar: proxySupabaseUrl(profile.avatarUrl) || '',
                    avatarType: profile.avatarType || 'default',
                    bio: profile.bio || '',
                    birthdate: profile.birthdate || undefined,
                    lastUsernameChange: profile.lastUsernameChange || undefined,
                    note: profile.note,
                    noteTimestamp: profile.note_timestamp,
                    country: profile.country || undefined,
                    countryCode: profile.countryCode || undefined
                };
                setCurrentUser(userObj);
                await AsyncStorage.setItem('ss_current_user', userId);
                await AsyncStorage.setItem('ss_cached_user_profile', JSON.stringify(userObj));
                await AsyncStorage.setItem('ss_cached_user_profile_at', String(Date.now()));
            } else {
                // FALLBACK: For Developer Bypass users (shri/hari) who don't exist in Supabase DB
                console.log('[AuthContext] Profile not found, applying bypass logic for:', userId);
                if (userId === LEGACY_TO_UUID['shri']) {
                    const bypassUser: User = {
                        id: userId,
                        name: 'Shri',
                        username: 'shri',
                        avatar: 'https://avatar.iran.liara.run/public/boy?username=shri',
                        avatarType: 'teddy',
                        bio: 'SoulSync Founder | Jai Shree Ram'
                    };
                    setCurrentUser(bypassUser);
                    await AsyncStorage.setItem('ss_current_user', userId);
                    await AsyncStorage.setItem('ss_cached_user_profile', JSON.stringify(bypassUser));
                } else if (userId === LEGACY_TO_UUID['hari']) {
                    const bypassUser: User = {
                        id: userId,
                        name: 'Hari',
                        username: 'hari',
                        avatar: 'https://avatar.iran.liara.run/public/boy?username=hari',
                        avatarType: 'teddy',
                        bio: 'SoulSync Dev | Om Namah Shivay'
                    };
                    setCurrentUser(bypassUser);
                    await AsyncStorage.setItem('ss_current_user', userId);
                    await AsyncStorage.setItem('ss_cached_user_profile', JSON.stringify(bypassUser));
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
    }, []);

    const synchronizeSessionWithTimeout = useCallback(async (userId: string, timeoutMs = 7000) => {
        await Promise.race([
            synchronizeSession(userId),
            new Promise((resolve) => setTimeout(() => {
                console.warn(`[AuthContext] synchronizeSession timed out after ${timeoutMs}ms for ${userId}`);
                resolve(null);
            }, timeoutMs))
        ]);
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
                    await synchronizeSession(user.id);
                }
            } else if (event === 'SIGNED_OUT') {
                // Super users (shri/hari) survive Supabase SIGNED_OUT events
                // (e.g. token refresh failures, network issues). They are only
                // cleared via the explicit logout() call.
                const cachedUserId = await AsyncStorage.getItem('ss_current_user');
                if (isDeveloperBypassId(cachedUserId)) {
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
    }, [isDeveloperBypassId, synchronizeSession]);

    useEffect(() => {
        let isMounted = true;
        let timeoutId: ReturnType<typeof setTimeout>;

        console.log('[AuthContext] Initializing - checking session...');
        
        const startInit = Date.now();
        
        // --- NEW: Block until Database Migration is verified (with 5s fail-safe) ---
        const dbPromise = getDb().then(() => {
            console.log(`[AuthContext] Database ready after ${Date.now() - startInit}ms`);
            return true;
        });

        const dbTimeout = new Promise<boolean>((resolve) => {
            setTimeout(() => {
                console.warn(`[AuthContext] Database initialization HUNG after 5s - continuing without DB for now`);
                resolve(false);
            }, 5000);
        });

        Promise.race([dbPromise, dbTimeout]).then(() => {
            console.log(`[AuthContext] DB phase complete after ${Date.now() - startInit}ms, starting session check...`);
            
            const sessionPromise = supabase.auth.getSession();
            const timeoutPromise = new Promise<null>((resolve) => {
                timeoutId = setTimeout(() => {
                    console.log(`[AuthContext] Session check TIMED OUT after ${Date.now() - startInit}ms, continuing to UI...`);
                    resolve(null);
                }, 10000);
            });

            return Promise.race([sessionPromise, timeoutPromise]);
        }).then((sessionResult: any) => {
            console.log(`[AuthContext] Initialization complete after ${Date.now() - startInit}ms. Setting isReady=true`);
            if (!isMounted) return;
            clearTimeout(timeoutId);

            // If timeout fired (null), skip session check
            if (!sessionResult) {
                setIsReady(true);
                return;
            }

            const session = sessionResult?.data?.session;
            const error = sessionResult?.error;

            if (error) {
                console.error('[AuthContext] Session check error:', error);
                setIsReady(true); // Signal ready even on error to unblock UI
                return;
            }

            if (session) {
                console.log('[AuthContext] Session found, syncing profile for:', session.user.id);
                // Race the entire sync process to ensure we don't hang the splash screen
                synchronizeSessionWithTimeout(session.user.id).finally(() => {
                    if (isMounted) {
                        console.log(`[AuthContext] Reached ready state (total init time: ${Date.now() - startInit}ms)`);
                        setIsReady(true);
                    }
                });
            } else {
                console.log('[AuthContext] No session found, checking cache...');
                AsyncStorage.getItem('ss_current_user').then(async (cachedUserId) => {
                    if (!isMounted) return;

                    if (cachedUserId) {
                        if (isDeveloperBypassId(cachedUserId)) {
                            console.log('[AuthContext] Restoring developer bypass user from local cache:', cachedUserId);
                            synchronizeSessionWithTimeout(cachedUserId).finally(() => {
                                if (isMounted) {
                                    console.log(`[AuthContext] Bypass cache restore complete (total init time: ${Date.now() - startInit}ms), readying app`);
                                    setIsReady(true);
                                }
                            });
                            return;
                        }

                        console.log('[AuthContext] Found cached user without active session:', cachedUserId);
                        console.log('[AuthContext] Attempting session refresh from persisted auth state...');

                        const refreshed = await authService.refreshSession();
                        const { data: refreshedSessionData } = await supabase.auth.getSession();
                        const refreshedUserId = refreshedSessionData.session?.user?.id;

                        if (refreshed && refreshedUserId) {
                            console.log('[AuthContext] Session restored. Syncing profile for:', refreshedUserId);
                            synchronizeSessionWithTimeout(refreshedUserId).finally(() => {
                                if (isMounted) {
                                    console.log(`[AuthContext] Refreshed session sync complete (total init time: ${Date.now() - startInit}ms), readying app`);
                                    setIsReady(true);
                                }
                            });
                            return;
                        }

                        const cachedProfileRaw = await AsyncStorage.getItem('ss_cached_user_profile');
                        const cachedAt = Number(await AsyncStorage.getItem('ss_cached_user_profile_at') || '0');
                        const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

                        if (cachedProfileRaw && (Date.now() - cachedAt) < CACHE_TTL_MS) {
                            try {
                                const parsed = JSON.parse(cachedProfileRaw) as User;
                                if (parsed?.id === cachedUserId) {
                                    console.warn('[AuthContext] Session missing, restoring cached profile in offline mode');
                                    setCurrentUser(parsed);
                                    if (isMounted) {
                                        setIsReady(true);
                                    }
                                    return;
                                }
                            } catch (parseError) {
                                console.warn('[AuthContext] Failed to parse cached profile:', parseError);
                            }
                        }

                        console.warn('[AuthContext] Cached user is stale (no valid session). Clearing local auth cache.');
                        setCurrentUser(null);
                        await AsyncStorage.multiRemove(['ss_current_user', 'ss_cached_user_profile']);
                        if (isMounted) {
                            setIsReady(true);
                        }
                        return;
                    }

                    console.log(`[AuthContext] No session or cached user (total init time: ${Date.now() - startInit}ms), readying app`);
                    setIsReady(true);
                }).catch((err) => {
                    console.error('[AuthContext] Cache check failed:', err);
                    if (isMounted) setIsReady(true);
                });
            }
        }).catch((err) => {
            if (!isMounted) return;
            clearTimeout(timeoutId);
            console.error('[AuthContext] Session check exception:', err);
            setIsReady(true); // Unblock UI on error
        });

        return () => {
            isMounted = false;
            if (timeoutId) clearTimeout(timeoutId);
        };
    }, [isDeveloperBypassId, synchronizeSession, synchronizeSessionWithTimeout]);

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
        } catch (e) {
            console.error('[AuthContext] Failed to clear local DB during logout:', e);
        }

        await authService.signOut();
        setCurrentUser(null);
        await AsyncStorage.multiRemove([
            'ss_current_user',
            'ss_cached_user_profile',
            'ss_cached_user_profile_at',
            'ss_device_session_id',
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
                    const newSessionId = payload.new.active_session_id;
                    const currentLocalId = deviceSessionIdRef.current;
                    
                    console.log(`[AuthContext] Session update detected: DB=${newSessionId}, Local=${currentLocalId}`);
                    
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
