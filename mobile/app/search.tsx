import React, { useState, useEffect, useCallback, useRef, useDeferredValue, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, Alert, Pressable } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SERVER_URL, proxySupabaseUrl } from '../config/api';
import { supabase, LEGACY_TO_UUID } from '../config/supabase';
import { useApp } from '../context/AppContext';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';

type SearchContext = 'chats' | 'calls' | 'settings';

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
    username?: string;
    display_name?: string;
    name?: string;
    avatar_url?: string;
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

type SectionRow = {
    type: 'section';
    id: string;
    title: string;
};

type SearchRow = SectionRow | ChatSearchResult | PersonResult | CallSearchResult | SettingsSearchResult;

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
    const params = useLocalSearchParams<{ context?: string }>();
    const searchContext: SearchContext =
        params.context === 'calls' ? 'calls' :
        params.context === 'settings' ? 'settings' : 'chats';

    const [query, setQuery] = useState('');
    const [peopleResults, setPeopleResults] = useState<PersonResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const router = useRouter();
    const debounceRef = useRef<NodeJS.Timeout | null>(null);
    const deferredQuery = useDeferredValue(query);

    const normalizedQuery = normalizeText(deferredQuery);

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
            let serverOk = false;
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
                        setPeopleResults((data.users || []).map((user: any) => ({
                            ...user,
                            type: 'person',
                        })));
                        serverOk = true;
                    }
                }
            } catch {}

            if (serverOk) return;

            const { data: profiles, error: sbError } = await supabase
                .from('profiles')
                .select('id, username, display_name, name, avatar_url')
                .or(`username.ilike.%${text}%,display_name.ilike.%${text}%,name.ilike.%${text}%`)
                .neq('id', userId)
                .limit(20);

            if (sbError) throw sbError;

            const searchLower = text.toLowerCase();
            const superusers = [
                { id: LEGACY_TO_UUID['shri'], username: 'shri', display_name: 'Shri', avatar_url: 'https://avatar.iran.liara.run/public/boy?username=shri' },
                { id: LEGACY_TO_UUID['hari'], username: 'hari', display_name: 'Hari', avatar_url: 'https://avatar.iran.liara.run/public/boy?username=hari' }
            ].filter((user) =>
                user.id !== userId &&
                (user.username.includes(searchLower) || user.display_name.toLowerCase().includes(searchLower)) &&
                !(profiles || []).some((profile) => profile.id === user.id)
            );

            const allProfiles = [...superusers, ...(profiles || [])];
            const allUserIds = allProfiles.map((profile) => profile.id);
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
                        const targetProfile = allProfiles.find((profile) => profile.id === targetId);
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

            setPeopleResults(allProfiles.map((profile: any) => ({
                ...profile,
                type: 'person',
                connectionStatus: statusMap[profile.id] || 'not_connected',
            })));
        } catch (err: any) {
            setSearchError(err?.message || 'Search failed');
            setPeopleResults([]);
        } finally {
            setLoading(false);
        }
    }, [currentUser?.id, currentUser?.username]);

    useEffect(() => {
        if (searchContext !== 'chats') {
            setPeopleResults([]);
            setSearchError(null);
            setLoading(false);
            return;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            void searchUsers(normalizedQuery);
        }, 220);

        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [normalizedQuery, searchUsers, searchContext]);

    const sendRequest = useCallback(async (receiverId: string) => {
        setPeopleResults((prev) => prev.map((user) => user.id === receiverId ? { ...user, connectionStatus: 'request_sent' } : user));

        try {
            const { error: reqErr } = await supabase.from('connection_requests')
                .insert({ sender_id: currentUser?.id, receiver_id: receiverId, status: 'pending' });

            if (reqErr) {
                setPeopleResults((prev) => prev.map((user) => user.id === receiverId ? { ...user, connectionStatus: 'not_connected' } : user));
                Alert.alert('Error', reqErr.message);
            }
        } catch (err: any) {
            setPeopleResults((prev) => prev.map((user) => user.id === receiverId ? { ...user, connectionStatus: 'not_connected' } : user));
            Alert.alert('Error', err?.message || 'Request failed');
        }
    }, [currentUser?.id]);

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
                await supabase.from('connection_requests')
                    .update({ status: 'accepted', responded_at: new Date().toISOString() })
                    .eq('id', pendingReq.id);
                const ids = [currentUser?.id || '', senderId].sort();
                await supabase.from('connections')
                    .upsert({ user_1_id: ids[0], user_2_id: ids[1] }, { onConflict: 'user_1_id,user_2_id' });
            }
        } catch (err: any) {
            setPeopleResults((prev) => prev.map((user) => user.id === senderId ? { ...user, connectionStatus: 'request_received' } : user));
            Alert.alert('Error', err?.message || 'Accept failed');
        }
    }, [currentUser?.id]);

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

        if (searchContext === 'chats') {
            if (chatResults.length > 0) {
                nextRows.push({ type: 'section', id: 'section-chats', title: 'Chats & Messages' });
                nextRows.push(...chatResults);
            }

            if (peopleWithoutOpenChats.length > 0) {
                nextRows.push({ type: 'section', id: 'section-people', title: 'People' });
                nextRows.push(...peopleWithoutOpenChats);
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
    }, [chatResults, callResults, settingsResults, normalizedQuery, peopleWithoutOpenChats, searchContext]);

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
                        <TouchableOpacity style={styles.connectButtonWrapper} onPress={() => sendRequest(item.id)}>
                            <LinearGradient colors={[activeTheme.primary, activeTheme.accent]} style={styles.connectButton}>
                                <Text style={styles.connectText}>Request</Text>
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

        return renderPersonResult(item, index);
    }, [renderChatResult, renderPersonResult, renderCallResult, renderSettingResult]);

    return (
        <View style={styles.container}>
            <LinearGradient colors={['#000000', '#080808']} style={StyleSheet.absoluteFill} />

            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backButton} activeOpacity={0.7}>
                    <MaterialIcons name="arrow-back-ios" size={20} color="#fff" />
                </TouchableOpacity>

                <View style={styles.searchWrapper}>
                    <GlassView intensity={30} tint="dark" style={styles.searchGlass} />
                    <View style={styles.searchContainer}>
                        <MaterialIcons name="search" size={20} color={activeTheme.primary} />
                        <TextInput
                            style={styles.searchInput}
                            placeholder={
                                searchContext === 'calls' ? 'Search call history...' :
                                searchContext === 'settings' ? 'Search settings...' :
                                'Search chats, messages, people...'
                            }
                            placeholderTextColor="rgba(255,255,255,0.4)"
                            value={query}
                            onChangeText={setQuery}
                            autoFocus
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
            </View>

            <FlashList
                data={rows}
                renderItem={renderItem}
                keyExtractor={(item) => item.id}
                estimatedItemSize={88}
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                    normalizedQuery.length > 0 && !loading ? (
                        <View style={styles.emptyContainer}>
                            <MaterialIcons name="search-off" size={60} color="rgba(255,255,255,0.1)" />
                            <Text style={styles.emptyText}>
                                {searchError ? 'Could not connect to search right now' : `No matches found for "${query.trim()}"`}
                            </Text>
                        </View>
                    ) : (
                        <View style={styles.emptyContainer}>
                            <MaterialIcons name="manage-search" size={60} color="rgba(255,255,255,0.1)" />
                            <Text style={styles.hintText}>Type a name or any message text to search like WhatsApp.</Text>
                        </View>
                    )
                }
            />
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
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: Platform.OS === 'ios' ? 60 : 40,
        paddingHorizontal: 20,
        marginBottom: 18,
        gap: 12,
    },
    backButton: {
        width: 44,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    searchWrapper: { flex: 1, height: 48, borderRadius: 24, overflow: 'hidden' },
    searchGlass: { ...StyleSheet.absoluteFillObject },
    searchContainer: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 15,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    searchInput: {
        flex: 1,
        color: '#fff',
        fontSize: 16,
        marginLeft: 10,
        height: '100%',
    },
    clearButton: {
        marginRight: 8,
    },
    list: {
        paddingHorizontal: 20,
        paddingBottom: 120,
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
        marginTop: 120,
        paddingHorizontal: 28,
    },
    emptyText: {
        color: 'rgba(255,255,255,0.3)',
        textAlign: 'center',
        marginTop: 16,
        fontSize: 16,
        fontWeight: '500',
    },
    hintText: {
        color: 'rgba(255,255,255,0.28)',
        textAlign: 'center',
        fontSize: 15,
        fontWeight: '500',
        marginTop: 16,
        lineHeight: 22,
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
