import React, { useState, useEffect, useCallback, useRef, useDeferredValue, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, Alert, Pressable, useWindowDimensions, KeyboardAvoidingView } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SERVER_URL, proxySupabaseUrl } from '../config/api';
import { supabase, LEGACY_TO_UUID } from '../config/supabase';
import { useApp } from '../context/AppContext';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown, Easing, Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type SearchContext = 'chats' | 'calls' | 'settings' | 'soulmate';
type SearchFilterId =
    | 'all'
    | 'chats'
    | 'people'
    | 'photos'
    | 'videos'
    | 'audio'
    | 'voice'
    | 'docs'
    | 'links'
    | 'calls'
    | 'settings';

type ChatSearchResult = {
    type: 'chat';
    id: string;
    contactId: string;
    title: string;
    avatar?: string;
    localAvatarUri?: string;
    avatarType?: any;
    teddyVariant?: any;
    subtitle: string;
    matchedBy: 'name' | 'message';
    timestamp?: string;
};

type PersonResult = {
    type: 'person';
    id: string;
    canonicalUserId?: string;
    username?: string;
    display_name?: string;
    name?: string;
    avatar_url?: string;
    isRequestable?: boolean;
    connectionStatus: 'not_connected' | 'request_sent' | 'request_received' | 'connected';
};

type CallSearchResult = {
    type: 'call';
    id: string;
    contactId: string;
    contactName: string;
    avatar?: string;
    callType: 'audio' | 'video';
    direction: 'incoming' | 'outgoing';
    status: string;
    time: string;
};

type SettingsSearchResult = {
    type: 'setting';
    id: string;
    title: string;
    subtitle?: string;
    icon: string;
    route?: string;
    action?: 'logout' | 'report' | 'clearCache' | 'notifications';
    danger?: boolean;
};

type MessageSearchResult = {
    type: 'message';
    id: string;
    contactId: string;
    title: string;
    avatar?: string;
    localAvatarUri?: string;
    avatarType?: any;
    teddyVariant?: any;
    messageText: string;
    timestamp?: string;
};

type MediaSearchResult = {
    type: 'media';
    id: string;
    contactId: string;
    title: string;
    avatar?: string;
    localAvatarUri?: string;
    avatarType?: any;
    teddyVariant?: any;
    caption: string;
    mediaType: 'media' | 'doc';
    mediaSubtype?: 'image' | 'video' | 'audio' | 'file';
    timestamp?: string;
};

type LinkSearchResult = {
    type: 'link';
    id: string;
    contactId: string;
    title: string;
    avatar?: string;
    localAvatarUri?: string;
    avatarType?: any;
    teddyVariant?: any;
    url: string;
    snippet: string;
    timestamp?: string;
};

type SectionRow = {
    type: 'section';
    id: string;
    title: string;
};

type SearchRow = SectionRow | ChatSearchResult | PersonResult | CallSearchResult | SettingsSearchResult | MessageSearchResult | MediaSearchResult | LinkSearchResult;

type ContextOption = {
    key: SearchFilterId;
    label: string;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SETTINGS_ITEMS: Omit<SettingsSearchResult, 'type'>[] = [
    { id: 'setting-theme', title: 'Theme', subtitle: 'Appearance, colors, accent', icon: 'palette', route: '/theme' },
    { id: 'setting-privacy', title: 'Privacy', subtitle: 'Last seen, profile photo, status', icon: 'key', route: '/privacy' },
    { id: 'setting-security', title: 'Security', subtitle: 'Two-step verification, fingerprint', icon: 'security', route: '/security' },
    { id: 'setting-notifications', title: 'Notifications', subtitle: 'Toggle notifications', icon: 'notifications', action: 'notifications' },
    { id: 'setting-storage', title: 'Storage Usage', subtitle: 'Manage storage and media', icon: 'data-usage', route: '/storage-management' },
    { id: 'setting-cache', title: 'Clear Cache', subtitle: 'Free up space', icon: 'cleaning-services', action: 'clearCache' },
    { id: 'setting-help', title: 'Help Center', subtitle: 'FAQs and support', icon: 'help-outline', route: '/help-center' },
    { id: 'setting-report', title: 'Report a Problem', subtitle: 'Send feedback', icon: 'bug-report', action: 'report' },
    { id: 'setting-about', title: 'About', subtitle: 'Version 1.0.0', icon: 'info-outline', route: '/about' },
    { id: 'setting-logout', title: 'Logout', subtitle: 'Sign out of your account', icon: 'logout', action: 'logout', danger: true },
];

const normalizeText = (value: string) => value.trim().toLowerCase();

const buildSnippet = (value?: string) => {
    const text = (value || '').trim();
    if (!text) return 'Open conversation';
    return text.length > 72 ? `${text.slice(0, 72).trimEnd()}...` : text;
};

export default function SearchScreen() {
    const { currentUser, activeTheme, unfriendContact, contacts, messages, calls, startCall, logout } = useApp() as any;
    const params = useLocalSearchParams<{ context?: string; sourceX?: string; sourceY?: string; sourceW?: string; sourceH?: string }>();
    const insets = useSafeAreaInsets();
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();
    const searchContext: SearchContext =
        params.context === 'calls' ? 'calls' :
        params.context === 'settings' ? 'settings' :
        params.context === 'soulmate' ? 'soulmate' : 'chats';
    
    console.log(`[Search] Initialized with context: ${searchContext}`);

    const [query, setQuery] = useState('');
    const [peopleResults, setPeopleResults] = useState<PersonResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [activeFilter, setActiveFilter] = useState<SearchFilterId>('chats');
    const router = useRouter();
    const debounceRef = useRef<NodeJS.Timeout | null>(null);
    const deferredQuery = useDeferredValue(query);
    const inputRef = useRef<TextInput | null>(null);

    const sourceFrame = useMemo(() => {
        const x = Number(params.sourceX);
        const y = Number(params.sourceY);
        const width = Number(params.sourceW);
        const height = Number(params.sourceH);

        if ([x, y, width, height].every((value) => Number.isFinite(value))) {
            return { x, y, width, height };
        }

        return {
            x: screenWidth - 72,
            y: screenHeight - 90,
            width: 56,
            height: 56,
        };
    }, [params.sourceH, params.sourceW, params.sourceX, params.sourceY, screenHeight, screenWidth]);

    const targetFrame = useMemo(() => {
        const bottomInset = insets.bottom || (Platform.OS === 'ios' ? 34 : 16);
        const y = screenHeight - bottomInset - 12 - 68;

        return {
            x: 20,
            y,
            width: screenWidth - 120,
            height: 68,
        };
    }, [insets.bottom, screenHeight, screenWidth]);

    const entryProgress = useSharedValue(0);

    const normalizedQuery = normalizeText(deferredQuery);

    const filterOptions = useMemo<ContextOption[]>(() => {
        if (searchContext === 'calls') {
            return [{ key: 'calls', label: 'Calls' }];
        }
        if (searchContext === 'settings') {
            return [{ key: 'settings', label: 'Settings' }];
        }
        return [
            { key: 'chats', label: 'Chats' },
            { key: 'photos', label: 'Photos' },
            { key: 'videos', label: 'Videos' },
            { key: 'docs', label: 'Documents' },
            { key: 'links', label: 'Links' },
            { key: 'audio', label: 'Audio' },
            { key: 'voice', label: 'Voice' },
        ];
    }, [searchContext]);

    useEffect(() => {
        setActiveFilter((prev) => {
            const next = filterOptions.some((o) => o.key === prev) ? prev : (filterOptions[0]?.key ?? 'chats');
            console.log(`[Search] Filter set to: ${next}`);
            return next;
        });
    }, [filterOptions]);

    useEffect(() => {
        entryProgress.value = withTiming(1, {
            duration: 420,
            easing: Easing.out(Easing.cubic),
        });

        const focusTimer = setTimeout(() => {
            inputRef.current?.focus();
        }, 170);

        return () => clearTimeout(focusTimer);
    }, [entryProgress]);

    const chatResults = useMemo<ChatSearchResult[]>(() => {
        if (!normalizedQuery || searchContext !== 'chats') return [];

        return (contacts || [])
            .filter((contact: any) => contact?.id && contact.id !== currentUser?.id && contact.isArchived !== true)
            .map((contact: any) => {
                const name = String(contact.name || '').toLowerCase();
                const identifier = String(contact.id || '').toLowerCase();
                const nameMatch = name.includes(normalizedQuery) || identifier.includes(normalizedQuery);
                const conversation = Array.isArray(messages?.[contact.id]) ? messages[contact.id] : [];
                const matchedMessage = [...conversation]
                    .reverse()
                    .find((message: any) => typeof message?.text === 'string' && message.text.toLowerCase().includes(normalizedQuery));
                const lastMessage = conversation[conversation.length - 1];

                if (!nameMatch && !matchedMessage) {
                    return null;
                }

                return {
                    type: 'chat',
                    id: `chat-${contact.id}`,
                    contactId: contact.id,
                    title: contact.name || contact.id,
                    avatar: contact.avatar,
                    localAvatarUri: contact.localAvatarUri,
                    avatarType: contact.avatarType,
                    teddyVariant: contact.teddyVariant,
                    subtitle: buildSnippet(nameMatch && !matchedMessage ? lastMessage?.text || contact.lastMessage : matchedMessage?.text),
                    matchedBy: matchedMessage ? 'message' : 'name',
                    timestamp: matchedMessage?.timestamp || lastMessage?.timestamp || '',
                } satisfies ChatSearchResult;
            })
            .filter(Boolean)
            .sort((a: any, b: any) => {
                if (a.matchedBy !== b.matchedBy) return a.matchedBy === 'name' ? -1 : 1;
                return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
            }) as ChatSearchResult[];
    }, [contacts, currentUser?.id, messages, normalizedQuery, searchContext]);

    const callResults = useMemo<CallSearchResult[]>(() => {
        if (!normalizedQuery || searchContext !== 'calls') return [];

        return (calls || [])
            .map((call: any) => {
                const contact = (contacts || []).find((c: any) => c.id === call.contactId);
                const name = String(contact?.name || call.contactName || 'Unknown').toLowerCase();
                const typeStr = String(call.callType || 'audio').toLowerCase();
                const directionStr = String(call.type || 'incoming').toLowerCase();
                const statusStr = String(call.status || '').toLowerCase();

                const nameMatch = name.includes(normalizedQuery);
                const typeMatch = typeStr.includes(normalizedQuery);
                const directionMatch = directionStr.includes(normalizedQuery);
                const statusMatch = statusStr.includes(normalizedQuery);
                const missedMatch = 'missed'.includes(normalizedQuery) && statusStr === 'missed';

                if (!nameMatch && !typeMatch && !directionMatch && !statusMatch && !missedMatch) {
                    return null;
                }

                return {
                    type: 'call',
                    id: `call-${call.id}`,
                    contactId: call.contactId,
                    contactName: contact?.name || call.contactName || 'Unknown',
                    avatar: contact?.avatar || call.avatar,
                    callType: call.callType || 'audio',
                    direction: call.type || 'incoming',
                    status: call.status || 'completed',
                    time: call.time || '',
                } satisfies CallSearchResult;
            })
            .filter(Boolean)
            .sort((a: any, b: any) => String(b.time || '').localeCompare(String(a.time || ''))) as CallSearchResult[];
    }, [calls, contacts, normalizedQuery, searchContext]);

    const messageResults = useMemo<MessageSearchResult[]>(() => {
        if (!normalizedQuery || searchContext !== 'chats') return [];

        return (contacts || [])
            .filter((contact: any) => contact?.id && contact.id !== currentUser?.id && contact.isArchived !== true)
            .flatMap((contact: any) => {
                const conversation = Array.isArray(messages?.[contact.id]) ? messages[contact.id] : [];
                return [...conversation]
                    .reverse()
                    .filter((message: any) => typeof message?.text === 'string' && message.text.toLowerCase().includes(normalizedQuery))
                    .slice(0, 3)
                    .map((message: any, index: number) => ({
                        type: 'message' as const,
                        id: `message-${contact.id}-${message.id || message.timestamp || index}`,
                        contactId: contact.id,
                        title: contact.name || contact.id,
                        avatar: contact.avatar,
                        localAvatarUri: contact.localAvatarUri,
                        avatarType: contact.avatarType,
                        teddyVariant: contact.teddyVariant,
                        messageText: buildSnippet(message.text),
                        timestamp: message.timestamp || '',
                    }));
            })
            .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
            .slice(0, 24);
    }, [contacts, currentUser?.id, messages, normalizedQuery, searchContext]);

    const mediaResults = useMemo<MediaSearchResult[]>(() => {
        if (!normalizedQuery || searchContext !== 'chats') return [];

        return (contacts || [])
            .filter((contact: any) => contact?.id && contact.id !== currentUser?.id && contact.isArchived !== true)
            .flatMap((contact: any) => {
                const conversation = Array.isArray(messages?.[contact.id]) ? messages[contact.id] : [];
                return [...conversation]
                    .reverse()
                    .filter((message: any) => {
                        const media = message?.media;
                        if (!media || media.type === 'file') return false;
                        const haystack = `${media.caption || ''} ${media.name || ''} ${contact.name || ''} ${media.type || ''}`.toLowerCase();
                        return haystack.includes(normalizedQuery);
                    })
                    .slice(0, 2)
                    .map((message: any, index: number) => ({
                        type: 'media' as const,
                        id: `media-${contact.id}-${message.id || message.timestamp || index}`,
                        contactId: contact.id,
                        title: contact.name || contact.id,
                        avatar: contact.avatar,
                        localAvatarUri: contact.localAvatarUri,
                        avatarType: contact.avatarType,
                        teddyVariant: contact.teddyVariant,
                        caption: buildSnippet(message?.media?.caption || message?.media?.name || `${message?.media?.type || 'media'} shared`),
                        mediaType: 'media' as const,
                        mediaSubtype: (message?.media?.type as 'image' | 'video' | 'audio' | undefined),
                        timestamp: message.timestamp || '',
                    }));
            })
            .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
            .slice(0, 18);
    }, [contacts, currentUser?.id, messages, normalizedQuery, searchContext]);

    const linkResults = useMemo<LinkSearchResult[]>(() => {
        if (!normalizedQuery || searchContext !== 'chats') return [];

        const urlRegex = /\bhttps?:\/\/\S+|\bwww\.\S+/i;

        return (contacts || [])
            .filter((contact: any) => contact?.id && contact.id !== currentUser?.id && contact.isArchived !== true)
            .flatMap((contact: any) => {
                const conversation = Array.isArray(messages?.[contact.id]) ? messages[contact.id] : [];
                return [...conversation]
                    .reverse()
                    .filter((message: any) => {
                        if (typeof message?.text !== 'string') return false;
                        const match = message.text.match(urlRegex);
                        if (!match) return false;
                        const haystack = `${message.text} ${contact.name || ''}`.toLowerCase();
                        return haystack.includes(normalizedQuery);
                    })
                    .slice(0, 3)
                    .map((message: any, index: number) => {
                        const match = (message.text as string).match(urlRegex);
                        return {
                            type: 'link' as const,
                            id: `link-${contact.id}-${message.id || message.timestamp || index}`,
                            contactId: contact.id,
                            title: contact.name || contact.id,
                            avatar: contact.avatar,
                            localAvatarUri: contact.localAvatarUri,
                            avatarType: contact.avatarType,
                            teddyVariant: contact.teddyVariant,
                            url: match?.[0] || '',
                            snippet: buildSnippet(message.text),
                            timestamp: message.timestamp || '',
                        };
                    });
            })
            .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
            .slice(0, 18);
    }, [contacts, currentUser?.id, messages, normalizedQuery, searchContext]);

    const docResults = useMemo<MediaSearchResult[]>(() => {
        if (!normalizedQuery || searchContext !== 'chats') return [];

        return (contacts || [])
            .filter((contact: any) => contact?.id && contact.id !== currentUser?.id && contact.isArchived !== true)
            .flatMap((contact: any) => {
                const conversation = Array.isArray(messages?.[contact.id]) ? messages[contact.id] : [];
                return [...conversation]
                    .reverse()
                    .filter((message: any) => {
                        const media = message?.media;
                        if (!media || media.type !== 'file') return false;
                        const haystack = `${media.caption || ''} ${media.name || ''} ${contact.name || ''} document doc file pdf}`.toLowerCase();
                        return haystack.includes(normalizedQuery);
                    })
                    .slice(0, 2)
                    .map((message: any, index: number) => ({
                        type: 'media' as const,
                        id: `doc-${contact.id}-${message.id || message.timestamp || index}`,
                        contactId: contact.id,
                        title: contact.name || contact.id,
                        avatar: contact.avatar,
                        localAvatarUri: contact.localAvatarUri,
                        avatarType: contact.avatarType,
                        teddyVariant: contact.teddyVariant,
                        caption: buildSnippet(message?.media?.name || message?.media?.caption || 'Document shared'),
                        mediaType: 'doc' as const,
                        mediaSubtype: 'file' as const,
                        timestamp: message.timestamp || '',
                    }));
            })
            .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
            .slice(0, 18);
    }, [contacts, currentUser?.id, messages, normalizedQuery, searchContext]);

    const settingsResults = useMemo<SettingsSearchResult[]>(() => {
        if (!normalizedQuery || searchContext !== 'settings') return [];

        return SETTINGS_ITEMS
            .filter((item) => {
                const haystack = `${item.title} ${item.subtitle || ''}`.toLowerCase();
                return haystack.includes(normalizedQuery);
            })
            .map((item) => ({ ...item, type: 'setting' } satisfies SettingsSearchResult));
    }, [normalizedQuery, searchContext]);

    const searchUsers = useCallback(async (text: string) => {
        if (text.length < 2) {
            setPeopleResults([]);
            setSearchError(null);
            setLoading(false);
            return;
        }

        setLoading(true);
        setSearchError(null);
        const userId = currentUser?.id || '';

        try {
            let apiUsers: any[] = [];
            try {
                const ctrl = new AbortController();
                const tid = setTimeout(() => ctrl.abort(), 2000);
                const res = await fetch(
                    `${SERVER_URL}/api/users/search?query=${encodeURIComponent(text)}`,
                    { headers: { 'x-user-id': userId }, signal: ctrl.signal }
                );
                clearTimeout(tid);

                if (res.ok) {
                    const data: any = await res.json();
                    if (data?.success) {
                        apiUsers = (data.users || []).map((user: any) => ({
                            ...user,
                            type: 'person',
                            canonicalUserId: user.id,
                            isRequestable: true,
                        }));
                    }
                }
            } catch {}

            const { data: profilesData, error: sbError } = await supabase
                .from('profiles')
                .select('id, username, display_name, name, avatar_url')
                .or(`username.ilike.%${text}%,display_name.ilike.%${text}%,name.ilike.%${text}%`)
                .neq('id', userId)
                .limit(20);

            if (sbError) throw sbError;
            const profiles = (profilesData || []).map((profile: any) => ({
                ...profile,
                type: 'person',
                canonicalUserId: UUID_REGEX.test(profile.id) ? profile.id : undefined,
                isRequestable: UUID_REGEX.test(profile.id),
            }));

            const searchLower = text.toLowerCase();
            const superusers = [
                { id: LEGACY_TO_UUID['shri'], canonicalUserId: LEGACY_TO_UUID['shri'], username: 'shri', display_name: 'Shri', avatar_url: 'https://avatar.iran.liara.run/public/boy?username=shri', isRequestable: true },
                { id: LEGACY_TO_UUID['hari'], canonicalUserId: LEGACY_TO_UUID['hari'], username: 'hari', display_name: 'Hari', avatar_url: 'https://avatar.iran.liara.run/public/boy?username=hari', isRequestable: true }
            ].filter((user) =>
                user.id !== userId &&
                (user.username.includes(searchLower) || user.display_name.toLowerCase().includes(searchLower)) &&
                !profiles.some((profile) => profile.id === user.id)
            );

            const mergedProfiles = [...profiles];
            if (apiUsers.length > 0) {
                apiUsers.forEach((au) => {
                    const existingIndex = mergedProfiles.findIndex((p) => p.username === au.username || p.id === au.id);
                    if (existingIndex >= 0) {
                        mergedProfiles[existingIndex] = {
                            ...mergedProfiles[existingIndex],
                            ...au,
                            isRequestable: true,
                        };
                    } else {
                        mergedProfiles.push(au);
                    }
                });
            }

            const requestableProfiles = [...superusers, ...mergedProfiles];

            const allUserIds = requestableProfiles.map((profile) => profile.id);
            const statusMap: Record<string, PersonResult['connectionStatus']> = {};

            if (allUserIds.length > 0) {
                const [connRes, reqRes] = await Promise.all([
                    supabase.from('connections').select('user_1_id, user_2_id')
                        .or(`user_1_id.eq.${userId},user_2_id.eq.${userId}`),
                    supabase.from('connection_requests').select('sender_id, receiver_id, status')
                        .eq('status', 'pending')
                        .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`),
                ]);

                (connRes.data || []).forEach((connection: any) => {
                    const otherId = connection.user_1_id === userId ? connection.user_2_id : connection.user_1_id;
                    if (allUserIds.includes(otherId)) statusMap[otherId] = 'connected';
                });

                (reqRes.data || []).forEach((request: any) => {
                    if (request.sender_id === userId && allUserIds.includes(request.receiver_id) && !statusMap[request.receiver_id]) {
                        statusMap[request.receiver_id] = 'request_sent';
                    } else if (request.receiver_id === userId && allUserIds.includes(request.sender_id) && !statusMap[request.sender_id]) {
                        statusMap[request.sender_id] = 'request_received';
                    }
                });

                const superUserIds = [LEGACY_TO_UUID['shri'], LEGACY_TO_UUID['hari']];
                const isMeSuper = superUserIds.includes(userId) ||
                    currentUser?.username === 'hari' ||
                    currentUser?.username === 'shri' ||
                    userId?.startsWith('f00f00f0');

                if (isMeSuper) {
                    allUserIds.forEach((targetId) => {
                        const targetProfile = requestableProfiles.find((profile) => profile.id === targetId);
                        const isTargetSuper = superUserIds.includes(targetId) ||
                            targetProfile?.username === 'hari' ||
                            targetProfile?.username === 'shri' ||
                            targetId?.startsWith('f00f00f0');

                        if (isTargetSuper) {
                            statusMap[targetId] = 'connected';
                        }
                    });
                }
            }

            setPeopleResults(requestableProfiles.map((profile: any) => ({
                ...profile,
                type: 'person',
                connectionStatus: statusMap[profile.id] || 'not_connected',
            })));
            console.log(`[Search] Found ${requestableProfiles.length} profiles for "${text}"`);
        } catch (err: any) {
            console.warn('[Search] API/DB search error:', err?.message);
            // Don't clear peopleResults here so we keep whatever we found from either source
            setSearchError(err?.message || 'Search failed');
        } finally {
            setLoading(false);
        }
    }, [currentUser?.id, currentUser?.username, searchContext]);

    useEffect(() => {
        if (searchContext !== 'chats' && searchContext !== 'soulmate') {
            setPeopleResults([]);
            setSearchError(null);
            setLoading(false);
            return;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            console.log(`[Search] Triggering search for: "${normalizedQuery}"`);
            void searchUsers(normalizedQuery);
        }, 150); // Reduced delay for snappier feel

        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [normalizedQuery, searchUsers, searchContext]);

    const sendRequest = useCallback(async (receiverId: string) => {
        setPeopleResults((prev) => prev.map((user) => user.id === receiverId ? { ...user, connectionStatus: 'request_sent' } : user));

        try {
            const senderId = currentUser?.id || '';
            const targetUser = peopleResults.find((user) => user.id === receiverId);
            if (!senderId) {
                throw new Error('Missing current user');
            }

            if (senderId === receiverId) {
                throw new Error('Cannot connect with yourself');
            }

            const normalizedReceiverId = receiverId.toLowerCase();
            const isSuperuser =
                normalizedReceiverId === LEGACY_TO_UUID['shri'] ||
                normalizedReceiverId === LEGACY_TO_UUID['hari'];

            let resolvedReceiverId = targetUser?.canonicalUserId || receiverId;

            if (!isSuperuser) {
                if (!targetUser?.username) {
                    throw new Error('This profile is not available for requests');
                }

                if (!targetUser?.isRequestable || !resolvedReceiverId || !UUID_REGEX.test(resolvedReceiverId)) {
                    const { data: canonicalId } = await supabase
                        .rpc('get_user_id_by_username', { p_username: targetUser.username });

                    if (canonicalId && UUID_REGEX.test(canonicalId)) {
                        resolvedReceiverId = canonicalId;
                        setPeopleResults((prev) => prev.map((user) => user.id === receiverId
                            ? { ...user, canonicalUserId: canonicalId, isRequestable: true }
                            : user));
                    }
                }

                const { data: authEmail, error: authLookupError } = await supabase
                    .rpc('get_email_by_username', { p_username: targetUser.username });

                if (!resolvedReceiverId || !UUID_REGEX.test(resolvedReceiverId) || authLookupError || !authEmail) {
                    throw new Error('This user is not available to connect yet');
                }
            }

            const { data: existingPending, error: pendingError } = await supabase
                .from('connection_requests')
                .select('id')
                .eq('sender_id', senderId)
                .eq('receiver_id', resolvedReceiverId)
                .eq('status', 'pending')
                .maybeSingle();

            if (pendingError) throw pendingError;
            if (existingPending) return;

            const { data: existingConnection, error: connectionError } = await supabase
                .from('connections')
                .select('id')
                .eq('user_1_id', [senderId, resolvedReceiverId].sort()[0])
                .eq('user_2_id', [senderId, resolvedReceiverId].sort()[1])
                .maybeSingle();

            if (connectionError) throw connectionError;
            if (existingConnection) {
                setPeopleResults((prev) => prev.map((user) => user.id === receiverId ? { ...user, connectionStatus: 'connected' } : user));
                return;
            }

            const { error: insertError } = await supabase
                .from('connection_requests')
                .insert({
                    sender_id: senderId,
                    receiver_id: resolvedReceiverId,
                    message: 'Connect with me!',
                    status: 'pending',
                });

            if (insertError) throw insertError;
        } catch (err: any) {
            console.warn('[Search] Request error:', err.message);
            setPeopleResults((prev) => prev.map((user) => user.id === receiverId ? { ...user, connectionStatus: 'not_connected' } : user));
            Alert.alert('Error', err?.message || 'Failed to send request.');
        }
    }, [currentUser?.id, peopleResults]);

    const cancelRequest = useCallback(async (receiverId: string) => {
        setPeopleResults((prev) => prev.map((user) => user.id === receiverId ? { ...user, connectionStatus: 'not_connected' } : user));

        try {
            await supabase.from('connection_requests')
                .delete()
                .eq('sender_id', currentUser?.id || '')
                .eq('receiver_id', receiverId)
                .eq('status', 'pending');
        } catch (err: any) {
            setPeopleResults((prev) => prev.map((user) => user.id === receiverId ? { ...user, connectionStatus: 'request_sent' } : user));
            Alert.alert('Error', err?.message || 'Cancel failed');
        }
    }, [currentUser?.id]);

    const handleAccept = useCallback(async (senderId: string) => {
        setPeopleResults((prev) => prev.map((user) => user.id === senderId ? { ...user, connectionStatus: 'connected' } : user));

        try {
            const { data: pendingReq } = await supabase.from('connection_requests')
                .select('id')
                .eq('sender_id', senderId)
                .eq('receiver_id', currentUser?.id || '')
                .eq('status', 'pending')
                .single();

            if (pendingReq) {
                const ids = [currentUser?.id || '', senderId].sort();
                const { error: connectionError } = await supabase.from('connections')
                    .upsert({ user_1_id: ids[0], user_2_id: ids[1] }, { onConflict: 'user_1_id,user_2_id' });
                if (connectionError) throw connectionError;

                const respondedAt = new Date().toISOString();
                const { error: requestError } = await supabase.from('connection_requests')
                    .update({ status: 'accepted', responded_at: respondedAt })
                    .eq('id', pendingReq.id);

                if (requestError) {
                    await supabase.from('connections')
                        .delete()
                        .eq('user_1_id', ids[0])
                        .eq('user_2_id', ids[1]);
                    throw requestError;
                }
            }
        } catch (err: any) {
            setPeopleResults((prev) => prev.map((user) => user.id === senderId ? { ...user, connectionStatus: 'request_received' } : user));
            Alert.alert('Error', err?.message || 'Accept failed');
        }
    }, [currentUser?.id]);

    useEffect(() => {
        const userId = currentUser?.id;
        if (!userId || normalizedQuery.length < 2 || (searchContext !== 'chats' && searchContext !== 'soulmate')) {
            return;
        }

        const refreshResults = () => {
            void searchUsers(normalizedQuery);
        };

        const channel = supabase
            .channel(`search-presence-${userId}`)
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'connection_requests', filter: `receiver_id=eq.${userId}` },
                refreshResults
            )
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'connection_requests', filter: `sender_id=eq.${userId}` },
                refreshResults
            )
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'connections', filter: `user_1_id=eq.${userId}` },
                refreshResults
            )
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'connections', filter: `user_2_id=eq.${userId}` },
                refreshResults
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [currentUser?.id, normalizedQuery, searchContext, searchUsers]);

    const handleUnfriend = useCallback(async (partnerId: string) => {
        Alert.alert(
            'Unfriend',
            'Are you sure you want to remove this friend?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Unfriend',
                    style: 'destructive',
                    onPress: async () => {
                        setPeopleResults((prev) => prev.map((user) => user.id === partnerId ? { ...user, connectionStatus: 'not_connected' } : user));
                        try {
                            await unfriendContact(partnerId);
                        } catch (err: any) {
                            setPeopleResults((prev) => prev.map((user) => user.id === partnerId ? { ...user, connectionStatus: 'connected' } : user));
                            Alert.alert('Error', err?.message || 'Unfriend failed');
                        }
                    }
                }
            ]
        );
    }, [unfriendContact]);

    const peopleWithoutOpenChats = useMemo(() => {
        const existingChatIds = new Set(chatResults.map((item) => item.contactId));
        return peopleResults.filter((item) => !existingChatIds.has(item.id));
    }, [chatResults, peopleResults]);

    const rows = useMemo<SearchRow[]>(() => {
        if (!normalizedQuery) return [];

        const nextRows: SearchRow[] = [];

        if (searchContext === 'chats' || searchContext === 'soulmate') {
            if (activeFilter === 'chats' || searchContext === 'soulmate') {
                if (chatResults.length > 0 && searchContext === 'chats') {
                    nextRows.push({ type: 'section', id: 'section-chats', title: 'Chats' });
                    nextRows.push(...chatResults);
                }
                
                // Show all discovered people so users can easily start new chats
                const showPeople = peopleResults;
                if (showPeople.length > 0) {
                    nextRows.push({ 
                        type: 'section', 
                        id: 'section-people', 
                        title: searchContext === 'soulmate' ? 'Soulmates Found' : 'People' 
                    });
                    nextRows.push(...showPeople);
                }
                
                if (messageResults.length > 0 && searchContext === 'chats') {
                    nextRows.push({ type: 'section', id: 'section-messages', title: 'Messages' });
                    nextRows.push(...messageResults);
                }
            } else if (activeFilter === 'photos') {
                const items = mediaResults.filter((r) => r.mediaSubtype === 'image');
                if (items.length > 0) {
                    nextRows.push({ type: 'section', id: 'section-photos', title: 'Photos' });
                    nextRows.push(...items);
                }
            } else if (activeFilter === 'videos') {
                const items = mediaResults.filter((r) => r.mediaSubtype === 'video');
                if (items.length > 0) {
                    nextRows.push({ type: 'section', id: 'section-videos', title: 'Videos' });
                    nextRows.push(...items);
                }
            } else if (activeFilter === 'audio' || activeFilter === 'voice') {
                const items = mediaResults.filter((r) => r.mediaSubtype === 'audio');
                if (items.length > 0) {
                    nextRows.push({
                        type: 'section',
                        id: `section-${activeFilter}`,
                        title: activeFilter === 'voice' ? 'Voice' : 'Audio',
                    });
                    nextRows.push(...items);
                }
            } else if (activeFilter === 'docs') {
                if (docResults.length > 0) {
                    nextRows.push({ type: 'section', id: 'section-docs', title: 'Documents' });
                    nextRows.push(...docResults);
                }
            } else if (activeFilter === 'links') {
                if (linkResults.length > 0) {
                    nextRows.push({ type: 'section', id: 'section-links', title: 'Links' });
                    nextRows.push(...linkResults);
                }
            }
        } else if (searchContext === 'calls') {
            if (callResults.length > 0) {
                nextRows.push({ type: 'section', id: 'section-calls', title: 'Call History' });
                nextRows.push(...callResults);
            }
        } else if (searchContext === 'settings') {
            if (settingsResults.length > 0) {
                nextRows.push({ type: 'section', id: 'section-settings', title: 'Settings' });
                nextRows.push(...settingsResults);
            }
        }

        return nextRows;
    }, [activeFilter, chatResults, callResults, docResults, linkResults, mediaResults, messageResults, normalizedQuery, peopleWithoutOpenChats, searchContext, settingsResults]);

    const renderChatResult = useCallback((item: ChatSearchResult, index: number) => (
        <Animated.View entering={FadeInDown.delay(Math.min(index * 35, 180)).duration(280)}>
            <Pressable
                style={styles.chatCard}
                onPress={() => router.push(`/chat/${item.contactId}`)}
            >
                <GlassView intensity={20} tint="dark" style={styles.glassBackground} />
                <View style={styles.cardContent}>
                    <SoulAvatar
                        uri={proxySupabaseUrl(item.avatar)}
                        localUri={item.localAvatarUri}
                        size={54}
                        avatarType={item.avatarType}
                        teddyVariant={item.teddyVariant}
                    />
                    <View style={styles.userInfo}>
                        <View style={styles.resultTitleRow}>
                            <Text style={styles.username} numberOfLines={1}>{item.title}</Text>
                            {!!item.timestamp && <Text style={styles.resultTime}>{formatSearchTime(item.timestamp)}</Text>}
                        </View>
                        <View style={styles.matchBadgeRow}>
                            <View style={[styles.matchBadge, item.matchedBy === 'message' ? styles.messageMatchBadge : styles.nameMatchBadge]}>
                                <Text style={styles.matchBadgeText}>{item.matchedBy === 'message' ? 'Message' : 'Chat'}</Text>
                            </View>
                        </View>
                        <Text style={styles.fullName} numberOfLines={2}>{item.subtitle}</Text>
                    </View>
                    <View style={styles.chatJumpButton}>
                        <MaterialIcons name="arrow-forward-ios" size={16} color="rgba(255,255,255,0.45)" />
                    </View>
                </View>
            </Pressable>
        </Animated.View>
    ), [router]);

    const renderPersonResult = useCallback((item: PersonResult, index: number) => (
        <Animated.View entering={FadeInDown.delay(Math.min(index * 35, 180)).duration(280)}>
            <View style={styles.userCard}>
                <GlassView intensity={25} tint="dark" style={styles.glassBackground} />
                <View style={styles.cardContent}>
                    <SoulAvatar uri={proxySupabaseUrl(item.avatar_url)} size={52} />
                    <View style={styles.userInfo}>
                        <Text style={styles.username} numberOfLines={1}>{item.username}</Text>
                        <Text style={styles.fullName} numberOfLines={1}>{item.display_name || item.name || `@${item.username}`}</Text>
                    </View>

                    {item.connectionStatus === 'not_connected' && (
                        <TouchableOpacity
                            style={styles.connectButtonWrapper}
                            onPress={() => item.isRequestable ? sendRequest(item.id) : Alert.alert('Unavailable', 'This user is not available to connect yet')}
                        >
                            <LinearGradient
                                colors={item.isRequestable ? [activeTheme.primary, activeTheme.accent] : ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.08)']}
                                style={[styles.connectButton, !item.isRequestable && { opacity: 0.7 }]}
                            >
                                <Text style={styles.connectText}>{item.isRequestable ? 'Request' : 'Unavailable'}</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                    )}

                    {item.connectionStatus === 'request_sent' && (
                        <View style={styles.pendingActionRow}>
                            <Text style={styles.pendingText}>Requested</Text>
                            <TouchableOpacity onPress={() => cancelRequest(item.id)} style={styles.cancelBtnSmall}>
                                <MaterialIcons name="close" size={18} color="#ff4444" />
                            </TouchableOpacity>
                        </View>
                    )}

                    {item.connectionStatus === 'request_received' && (
                        <TouchableOpacity style={styles.connectButtonWrapper} onPress={() => handleAccept(item.id)}>
                            <LinearGradient colors={['#22c55e', '#16a34a']} style={[styles.connectButton, { opacity: 0.9 }]}>
                                <Text style={styles.connectText}>Accept</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                    )}

                    {item.connectionStatus === 'connected' && (
                        <View style={styles.connectedActions}>
                            <TouchableOpacity style={styles.chatButton} onPress={() => router.push(`/chat/${item.id}`)}>
                                <LinearGradient colors={[activeTheme.primary, activeTheme.accent]} style={styles.chatButtonGradient}>
                                    <MaterialIcons name="chat" size={20} color="#fff" />
                                </LinearGradient>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.unfriendButton} onPress={() => handleUnfriend(item.id)}>
                                <MaterialIcons name="person-remove" size={20} color="rgba(255,255,255,0.4)" />
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
            </View>
        </Animated.View>
    ), [activeTheme, cancelRequest, handleAccept, handleUnfriend, router, sendRequest]);

    const renderCallResult = useCallback((item: CallSearchResult, index: number) => {
        const isMissed = item.status === 'missed';
        const isIncoming = item.direction === 'incoming';
        return (
            <Animated.View entering={FadeInDown.delay(Math.min(index * 35, 180)).duration(280)}>
                <Pressable
                    style={styles.chatCard}
                    onPress={() => {
                        if (startCall && item.contactId) {
                            startCall(item.contactId, item.callType);
                        }
                    }}
                >
                    <GlassView intensity={20} tint="dark" style={styles.glassBackground} />
                    <View style={styles.cardContent}>
                        <SoulAvatar uri={proxySupabaseUrl(item.avatar)} size={52} />
                        <View style={styles.userInfo}>
                            <View style={styles.resultTitleRow}>
                                <Text style={[styles.username, isMissed && { color: '#ef4444' }]} numberOfLines={1}>
                                    {item.contactName}
                                </Text>
                                {!!item.time && <Text style={styles.resultTime}>{formatSearchTime(item.time)}</Text>}
                            </View>
                            <View style={styles.callDetailsRow}>
                                <MaterialIcons
                                    name={isIncoming ? 'call-received' : 'call-made'}
                                    size={14}
                                    color={isMissed ? '#ef4444' : 'rgba(255,255,255,0.5)'}
                                />
                                <Text style={[styles.fullName, { marginTop: 0 }, isMissed && { color: '#ef4444' }]} numberOfLines={1}>
                                    {item.callType === 'video' ? 'Video' : 'Audio'} • {item.status}
                                </Text>
                            </View>
                        </View>
                        <View style={[styles.callActionButton, { backgroundColor: `${activeTheme.primary}1A` }]}>
                            <MaterialIcons
                                name={item.callType === 'video' ? 'videocam' : 'call'}
                                size={20}
                                color={activeTheme.primary}
                            />
                        </View>
                    </View>
                </Pressable>
            </Animated.View>
        );
    }, [activeTheme.primary, startCall]);

    const handleSettingPress = useCallback((item: SettingsSearchResult) => {
        if (item.route) {
            router.push(item.route as any);
            return;
        }
        if (item.action === 'logout') {
            Alert.alert('Logout', 'Are you sure you want to logout?', [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Logout',
                    style: 'destructive',
                    onPress: async () => {
                        await logout?.();
                        router.replace('/login' as any);
                    },
                },
            ]);
            return;
        }
        if (item.action === 'report') {
            router.back();
            return;
        }
        if (item.action === 'clearCache') {
            Alert.alert('Clear Cache', 'This will clear cached data. Your messages and contacts will be preserved.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Clear', onPress: () => Alert.alert('Success', 'Cache cleared successfully') },
            ]);
            return;
        }
        if (item.action === 'notifications') {
            router.push('/(tabs)/settings' as any);
        }
    }, [logout, router]);

    const renderSettingResult = useCallback((item: SettingsSearchResult, index: number) => (
        <Animated.View entering={FadeInDown.delay(Math.min(index * 35, 180)).duration(280)}>
            <Pressable style={styles.settingSearchCard} onPress={() => handleSettingPress(item)}>
                <GlassView intensity={20} tint="dark" style={styles.glassBackground} />
                <View style={styles.cardContent}>
                    <View style={[
                        styles.settingSearchIcon,
                        { backgroundColor: item.danger ? 'rgba(239,68,68,0.12)' : `${activeTheme.primary}20` },
                    ]}>
                        <MaterialIcons
                            name={item.icon as any}
                            size={22}
                            color={item.danger ? '#ef4444' : activeTheme.primary}
                        />
                    </View>
                    <View style={styles.userInfo}>
                        <Text style={[styles.username, item.danger && { color: '#ef4444' }]} numberOfLines={1}>
                            {item.title}
                        </Text>
                        {!!item.subtitle && <Text style={styles.fullName} numberOfLines={1}>{item.subtitle}</Text>}
                    </View>
                    <View style={styles.chatJumpButton}>
                        <MaterialIcons name="arrow-forward-ios" size={16} color="rgba(255,255,255,0.45)" />
                    </View>
                </View>
            </Pressable>
        </Animated.View>
    ), [activeTheme.primary, handleSettingPress]);

    const renderSimpleRow = useCallback((
        item: MessageSearchResult | MediaSearchResult | LinkSearchResult,
        index: number,
    ) => {
        const subtitle = item.type === 'message'
            ? item.messageText
            : item.type === 'media'
                ? item.caption
                : item.snippet;
        const badge = item.type === 'message'
            ? 'Message'
            : item.type === 'media'
                ? (item.mediaSubtype === 'video' ? 'Video'
                    : item.mediaSubtype === 'image' ? 'Photo'
                    : item.mediaSubtype === 'audio' ? 'Voice'
                    : item.mediaSubtype === 'file' ? 'Document'
                    : 'Media')
                : 'Link';

        return (
            <Animated.View entering={FadeInDown.delay(Math.min(index * 35, 180)).duration(280)}>
                <Pressable
                    style={styles.chatCard}
                    onPress={() => router.push(`/chat/${item.contactId}`)}
                >
                    <GlassView intensity={20} tint="dark" style={styles.glassBackground} />
                    <View style={styles.cardContent}>
                        <SoulAvatar
                            uri={proxySupabaseUrl(item.avatar)}
                            localUri={item.localAvatarUri}
                            size={54}
                            avatarType={item.avatarType}
                            teddyVariant={item.teddyVariant}
                        />
                        <View style={styles.userInfo}>
                            <View style={styles.resultTitleRow}>
                                <Text style={styles.username} numberOfLines={1}>{item.title}</Text>
                                {!!item.timestamp && <Text style={styles.resultTime}>{formatSearchTime(item.timestamp)}</Text>}
                            </View>
                            <View style={styles.matchBadgeRow}>
                                <View style={[styles.matchBadge, styles.messageMatchBadge]}>
                                    <Text style={styles.matchBadgeText}>{badge}</Text>
                                </View>
                            </View>
                            <Text style={styles.fullName} numberOfLines={2}>{subtitle}</Text>
                        </View>
                        <View style={styles.chatJumpButton}>
                            <MaterialIcons name="arrow-forward-ios" size={16} color="rgba(255,255,255,0.45)" />
                        </View>
                    </View>
                </Pressable>
            </Animated.View>
        );
    }, [router]);

    const renderItem = useCallback(({ item, index }: { item: SearchRow; index: number }) => {
        if (item.type === 'section') {
            return (
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>{item.title}</Text>
                </View>
            );
        }

        if (item.type === 'chat') {
            return renderChatResult(item, index);
        }

        if (item.type === 'call') {
            return renderCallResult(item, index);
        }

        if (item.type === 'setting') {
            return renderSettingResult(item, index);
        }

        if (item.type === 'person') {
            return renderPersonResult(item, index);
        }

        return renderSimpleRow(item, index);
    }, [renderChatResult, renderPersonResult, renderCallResult, renderSettingResult, renderSimpleRow]);

    const transitionBubbleStyle = useAnimatedStyle(() => {
        return {
            opacity: interpolate(entryProgress.value, [0, 0.52, 0.72], [1, 0.92, 0], Extrapolation.CLAMP),
            transform: [
                { translateX: interpolate(entryProgress.value, [0, 1], [sourceFrame.x, targetFrame.x], Extrapolation.CLAMP) },
                { translateY: interpolate(entryProgress.value, [0, 0.82, 1], [sourceFrame.y, targetFrame.y - 10, targetFrame.y], Extrapolation.CLAMP) },
                { scale: interpolate(entryProgress.value, [0, 0.78, 1], [1, 1.015, 1], Extrapolation.CLAMP) },
            ],
            width: interpolate(entryProgress.value, [0, 1], [sourceFrame.width, targetFrame.width], Extrapolation.CLAMP),
            height: interpolate(entryProgress.value, [0, 1], [sourceFrame.height, targetFrame.height], Extrapolation.CLAMP),
            borderRadius: interpolate(entryProgress.value, [0, 1], [sourceFrame.height / 2, targetFrame.height / 2], Extrapolation.CLAMP),
        };
    }, [sourceFrame, targetFrame]);

    const transitionBubbleInnerStyle = useAnimatedStyle(() => ({
        opacity: interpolate(entryProgress.value, [0, 0.22, 0.48], [1, 0.78, 0], Extrapolation.CLAMP),
        transform: [
            {
                scale: interpolate(entryProgress.value, [0, 0.32, 1], [1, 0.92, 0.92], Extrapolation.CLAMP),
            },
        ],
    }));

    const backdropFadeStyle = useAnimatedStyle(() => ({
        opacity: interpolate(entryProgress.value, [0, 0.18, 1], [0, 0.72, 1], Extrapolation.CLAMP),
    }));

    const headerRevealStyle = useAnimatedStyle(() => ({
        opacity: interpolate(entryProgress.value, [0.14, 0.5, 1], [0, 0.82, 1], Extrapolation.CLAMP),
        transform: [
            {
                translateY: interpolate(entryProgress.value, [0, 1], [18, 0], Extrapolation.CLAMP),
            },
        ],
    }));

    const resultsRevealStyle = useAnimatedStyle(() => ({
        opacity: interpolate(entryProgress.value, [0.38, 0.7, 1], [0, 0.8, 1], Extrapolation.CLAMP),
        transform: [
            {
                translateY: interpolate(entryProgress.value, [0, 1], [26, 0], Extrapolation.CLAMP),
            },
        ],
    }));

    return (
        <View style={styles.container}>
            <LinearGradient colors={['#000000', '#080808']} style={StyleSheet.absoluteFill} />
            <Animated.View style={[styles.backdropScrim, backdropFadeStyle]} pointerEvents="none" />

            <Animated.View style={[styles.transitionBubble, transitionBubbleStyle]} pointerEvents="none">
                <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFillObject} />
                <Animated.View style={[styles.transitionBubbleInner, transitionBubbleInnerStyle]}>
                    <Ionicons name="search" size={20} color="#8E8E93" />
                </Animated.View>
            </Animated.View>

            <KeyboardAvoidingView
                style={styles.keyboardAvoid}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <Animated.View style={[styles.resultsWrap, resultsRevealStyle, { paddingTop: insets.top + 12 }]}>
                    <FlashList
                        data={rows}
                        renderItem={renderItem}
                        keyExtractor={(item) => item.id}
                        estimatedItemSize={88}
                        contentContainerStyle={styles.list}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode="on-drag"
                        ListEmptyComponent={
                            normalizedQuery.length > 0 && !loading ? (
                                <View style={styles.emptyContainer}>
                                    <View style={styles.emptyIconCircle}>
                                        <MaterialIcons name="favorite-border" size={42} color="rgba(255,255,255,0.15)" />
                                    </View>
                                    <Text style={styles.emptyText}>
                                        {searchError ? 'Could not connect to search right now' : `No soulmates found for "${query.trim()}"`}
                                    </Text>
                                </View>
                            ) : (
                                <View style={styles.emptyContainer}>
                                    <View style={styles.emptyIconCircle}>
                                        <Ionicons name="heart-outline" size={48} color="rgba(255,255,255,0.1)" />
                                    </View>
                                    <Text style={styles.hintText}>Search by name or username to find your soulmate.</Text>
                                </View>
                            )
                        }
                    />
                </Animated.View>

                <Animated.View 
                    key={searchContext}
                    style={[styles.hero, { paddingBottom: (insets.bottom || 12) + 4 }, headerRevealStyle]}
                >
                    {searchContext === 'chats' && (
                        <View style={styles.segmentRail}>
                            <GlassView intensity={24} tint="dark" style={StyleSheet.absoluteFillObject} />
                            <Animated.ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={styles.segmentRailContent}
                            >
                                {filterOptions.map((option) => {
                                    const active = option.key === activeFilter;
                                    return (
                                        <Pressable
                                            key={option.key}
                                            onPress={() => setActiveFilter(option.key)}
                                            style={[styles.segmentChip, active && styles.segmentChipActive]}
                                        >
                                            <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
                                                {option.label}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </Animated.ScrollView>
                        </View>
                    )}

                    <View style={styles.searchHeroRow}>
                        <View style={styles.searchWrapper}>
                            <GlassView intensity={30} tint="dark" style={styles.searchGlass} />
                            <View style={styles.searchContainer}>
                                <MaterialIcons name="search" size={20} color="rgba(255,255,255,0.45)" />
                                <TextInput
                                    ref={inputRef}
                                    style={styles.searchInput}
                                    placeholder={
                                        searchContext === 'calls' ? 'Search call history...' :
                                        searchContext === 'settings' ? 'Search settings...' :
                                        searchContext === 'soulmate' ? 'Search for your soulmate...' :
                                        'Search chats, messages, people...'
                                    }
                                    placeholderTextColor="rgba(255,255,255,0.4)"
                                    value={query}
                                    onChangeText={setQuery}
                                    selectionColor={activeTheme.primary}
                                    returnKeyType="search"
                                />
                                {query.length > 0 && (
                                    <TouchableOpacity onPress={() => setQuery('')} style={styles.clearButton}>
                                        <Ionicons name="close-circle" size={20} color="rgba(255,255,255,0.3)" />
                                    </TouchableOpacity>
                                )}
                                {loading && <ActivityIndicator color={activeTheme.primary} size="small" />}
                            </View>
                        </View>

                        <TouchableOpacity onPress={() => router.back()} style={styles.closeButton} activeOpacity={0.8}>
                            <GlassView intensity={30} tint="dark" style={StyleSheet.absoluteFillObject} />
                            <Ionicons name="close" size={24} color="#fff" />
                        </TouchableOpacity>
                    </View>
                </Animated.View>
            </KeyboardAvoidingView>
        </View>
    );
}

const formatSearchTime = (timestamp?: string) => {
    if (!timestamp) return '';

    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';

    return date.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
    });
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    backdropScrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: '#000',
    },
    transitionBubble: {
        position: 'absolute',
        overflow: 'hidden',
        borderWidth: 1.1,
        borderColor: 'rgba(255,255,255,0.16)',
        zIndex: 20,
        shadowColor: '#000',
        shadowOpacity: 0.24,
        shadowRadius: 22,
        shadowOffset: { width: 0, height: 10 },
    },
    transitionBubbleInner: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    keyboardAvoid: {
        flex: 1,
    },
    hero: {
        paddingHorizontal: 20,
        paddingTop: 6,
    },
    segmentRail: {
        height: 42,
        borderRadius: 21,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        marginBottom: 14,
    },
    segmentRailContent: {
        paddingHorizontal: 6,
        alignItems: 'center',
        gap: 6,
    },
    segmentChip: {
        height: 32,
        borderRadius: 16,
        paddingHorizontal: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    segmentChipActive: {
        backgroundColor: 'rgba(255,255,255,0.12)',
    },
    segmentLabel: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 14,
        fontWeight: '700',
    },
    segmentLabelActive: {
        color: '#fff',
    },
    searchHeroRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginBottom: 8,
    },
    searchWrapper: { flex: 1, height: 46, borderRadius: 23, overflow: 'hidden' },
    searchGlass: { ...StyleSheet.absoluteFillObject },
    searchContainer: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    searchInput: {
        flex: 1,
        color: '#fff',
        fontSize: 15,
        marginLeft: 10,
        height: '100%',
    },
    closeButton: {
        width: 46,
        height: 46,
        borderRadius: 23,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    clearButton: {
        marginRight: 8,
    },
    resultsWrap: {
        flex: 1,
    },
    list: {
        paddingHorizontal: 20,
        paddingBottom: 16,
        paddingTop: 8,
    },
    sectionHeader: {
        paddingTop: 8,
        paddingBottom: 10,
    },
    sectionTitle: {
        color: 'rgba(255,255,255,0.42)',
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
    },
    userCard: {
        height: 84,
        borderRadius: 24,
        marginBottom: 14,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
    },
    chatCard: {
        minHeight: 92,
        borderRadius: 24,
        marginBottom: 14,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
    },
    glassBackground: { ...StyleSheet.absoluteFillObject },
    cardContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    userInfo: {
        flex: 1,
        marginLeft: 16,
        minWidth: 0,
    },
    resultTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    username: {
        flex: 1,
        color: '#fff',
        fontSize: 17,
        fontWeight: '700',
    },
    resultTime: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 12,
        fontWeight: '600',
    },
    fullName: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 14,
        marginTop: 4,
    },
    matchBadgeRow: {
        flexDirection: 'row',
        marginTop: 8,
        marginBottom: 2,
    },
    matchBadge: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
    },
    nameMatchBadge: {
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderColor: 'rgba(255,255,255,0.08)',
    },
    messageMatchBadge: {
        backgroundColor: 'rgba(188,0,42,0.18)',
        borderColor: 'rgba(188,0,42,0.35)',
    },
    matchBadgeText: {
        color: '#fff',
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.3,
    },
    connectButtonWrapper: {
        borderRadius: 20,
        overflow: 'hidden',
    },
    connectButton: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 20,
        minWidth: 90,
        alignItems: 'center',
    },
    connectText: {
        color: '#fff',
        fontWeight: '800',
        fontSize: 13,
        letterSpacing: 0.5,
    },
    pendingActionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    pendingText: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 12,
        fontWeight: '600',
    },
    cancelBtnSmall: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: 'rgba(255, 68, 68, 0.12)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 68, 68, 0.2)',
    },
    connectedActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    chatButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        overflow: 'hidden',
        shadowColor: '#3b82f6',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 4,
    },
    chatButtonGradient: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    unfriendButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.05)',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    chatJumpButton: {
        width: 34,
        height: 34,
        borderRadius: 17,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.04)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 140,
        paddingHorizontal: 40,
    },
    emptyIconCircle: {
        width: 100,
        height: 100,
        borderRadius: 50,
        backgroundColor: 'rgba(255,255,255,0.03)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
    },
    hintText: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 15,
        fontWeight: '600',
        lineHeight: 22,
        textAlign: 'center',
    },
    emptyText: {
        color: 'rgba(255,255,255,0.35)',
        fontSize: 15,
        fontWeight: '600',
        textAlign: 'center',
    },
    callDetailsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 6,
    },
    callActionButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingSearchCard: {
        minHeight: 78,
        borderRadius: 24,
        marginBottom: 14,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
    },
    settingSearchIcon: {
        width: 44,
        height: 44,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
