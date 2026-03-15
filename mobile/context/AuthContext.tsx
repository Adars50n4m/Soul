import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react';
import { supabase, LEGACY_TO_UUID } from '../config/supabase';
import { authService } from '../services/AuthService';
import { offlineService } from '../services/LocalDBService';
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

export interface User {
    id: string;
    name: string;
    avatar: string;
    bio: string;
    username?: string;
    birthdate?: string;
    lastUsernameChange?: string;
    note?: string;
    noteTimestamp?: string;
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
    const currentUserRef = useRef<User | null>(null);

    useEffect(() => {
        currentUserRef.current = currentUser;
    }, [currentUser]);

    const synchronizeSession = useCallback(async (userId: string) => {
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
            if (profile) {
                const userObj: User = {
                    id: profile.id,
                    name: profile.displayName || profile.username || 'User',
                    username: profile.username,
                    avatar: profile.avatarUrl || '',
                    bio: profile.bio || '',
                    birthdate: profile.birthdate || undefined,
                    lastUsernameChange: profile.lastUsernameChange || undefined,
                    note: profile.note,
                    noteTimestamp: profile.note_timestamp
                };
                setCurrentUser(userObj);
                await AsyncStorage.setItem('ss_current_user', userId);
            }
        } catch (e) {
            console.error('[AuthContext] Session synchronization failed:', e);
        }
    }, []);

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
                    bio: data.bio || prev.bio,
                    note: data.note || prev.note,
                    noteTimestamp: data.note_timestamp || prev.noteTimestamp
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
                setCurrentUser(null);
                await AsyncStorage.removeItem('ss_current_user');
            } else if (event === 'PASSWORD_RECOVERY') {
                router.push('/forgot-password?mode=reset' as any);
            }
        };

        const { data: { subscription } } = authService.onAuthStateChange(handleAuthChange);

        return () => subscription.unsubscribe();
    }, [synchronizeSession]);

    useEffect(() => {
        let isMounted = true;
        let timeoutId: ReturnType<typeof setTimeout>;

        console.log('[AuthContext] Initializing - checking session...');

        // Set a safety timeout to prevent app from hanging forever
        const sessionPromise = supabase.auth.getSession();
        const timeoutPromise = new Promise<null>((resolve) => {
            timeoutId = setTimeout(() => {
                console.log('[AuthContext] Session check timed out, continuing anyway');
                resolve(null);
            }, 5000); // 5 second timeout
        });

        Promise.race([sessionPromise, timeoutPromise]).then((sessionResult: any) => {
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
                console.log('[AuthContext] Session found, syncing profile...');
                synchronizeSession(session.user.id).finally(() => {
                    if (isMounted) {
                        console.log('[AuthContext] Profile sync complete, readying app');
                        setIsReady(true);
                    }
                });
            } else {
                console.log('[AuthContext] No session found, readying app');
                setIsReady(true);
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
    }, [synchronizeSession]);

    const login = useCallback(async (emailOrUsername: string, password: string): Promise<boolean> => {
        const result = await authService.signInWithPassword(emailOrUsername, password);
        return result.success;
    }, []);

    const setSession = useCallback(async (userId: string) => {
        await synchronizeSession(userId);
    }, [synchronizeSession]);

    const logout = useCallback(async () => {
        await authService.signOut();
        setCurrentUser(null);
        await AsyncStorage.removeItem('ss_current_user');
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
                    note: updates.note,
                    note_timestamp: updates.noteTimestamp
                })
                .eq('id', currentUser.id);

            if (!error) {
                await refreshProfile(currentUser.id);
            }
        } catch (e) {
            console.error('[AuthContext] Update profile failed:', e);
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
