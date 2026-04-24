import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, RefreshControl, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SERVER_URL, proxySupabaseUrl } from '../config/api';
import { supabase } from '../config/supabase';
import { useApp } from '../context/AppContext';
import { useChat } from '../context/ChatContext';
import { MaterialIcons } from '@expo/vector-icons';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';

export default function RequestsScreen() {
    const { currentUser, activeTheme } = useApp();
    const { refreshLocalCache } = useChat();
    const [incoming, setIncoming] = useState<any[]>([]);
    const [outgoing, setOutgoing] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [actionId, setActionId] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const router = useRouter();

    const fetchRequests = useCallback(async () => {
        setErrorMsg(null);
        const userId = currentUser?.id || '';
        try {
            // Try server with 2s timeout (no retries)
            let serverOk = false;
            try {
                const ctrl = new AbortController();
                const tid = setTimeout(() => ctrl.abort(), 2000);
                const res = await fetch(`${SERVER_URL}/api/connections/requests`, {
                    headers: { 'x-user-id': userId },
                    signal: ctrl.signal,
                });
                clearTimeout(tid);
                if (res.ok) {
                    const data = await res.json() as any;
                    if (data?.success) {
                        setIncoming(data.incoming || []);
                        setOutgoing(data.outgoing || []);
                        serverOk = true;
                    }
                }
            } catch (_) {}
            if (serverOk) return;

            // Direct Supabase (instant)
            const { data: inReqs } = (await supabase
                .from('connection_requests')
                .select('id, sender_id, receiver_id, message, status, sent_at')
                .eq('receiver_id', userId)
                .eq('status', 'pending')) as any;

            const { data: outReqs } = (await supabase
                .from('connection_requests')
                .select('id, sender_id, receiver_id, message, status, sent_at')
                .eq('sender_id', userId)
                .eq('status', 'pending')) as any;

            // Enrich with profile data
            const allIds = [
                ...(inReqs || []).map(r => r.sender_id),
                ...(outReqs || []).map(r => r.receiver_id),
            ].filter(Boolean);

            let profileMap: Record<string, any> = {};
            if (allIds.length > 0) {
                const { data: profiles } = (await supabase
                    .from('profiles')
                    .select('id, username, display_name, avatar_url')
                    .in('id', allIds)) as any;
                (profiles || []).forEach(p => { profileMap[p.id] = p; });
            }

            setIncoming((inReqs || []).map(r => ({
                ...r,
                sender: profileMap[r.sender_id] || { username: 'Unknown' },
            })));
            setOutgoing((outReqs || []).map(r => ({
                ...r,
                receiver: profileMap[r.receiver_id] || { username: 'Unknown' },
            })));
        } catch (err: any) {
            setErrorMsg(err?.message || 'Network error');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [currentUser]);

    useEffect(() => {
        fetchRequests();
    }, [fetchRequests]);

    // Realtime: refresh whenever a connection_request is inserted/updated/deleted for current user
    useEffect(() => {
        const userId = currentUser?.id;
        if (!userId) return;

        const channel = supabase
            .channel(`requests-${userId}`)
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'connection_requests', filter: `receiver_id=eq.${userId}` },
                () => { fetchRequests(); }
            )
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'connection_requests', filter: `sender_id=eq.${userId}` },
                () => { fetchRequests(); }
            )
            .subscribe();

        return () => { supabase.removeChannel(channel); };
    }, [currentUser?.id, fetchRequests]);

    const handleAction = async (requestId: string, action: 'accept' | 'reject' | 'cancel') => {
        setActionId(requestId);
        try {
            // Direct Supabase (fast, no server dependency)
            if (action === 'accept') {
                // Get the request to find sender/receiver
                const request = incoming.find(r => r.id === requestId);
                if (request) {
                    const ids = [request.sender_id, request.receiver_id].sort();
                    const { error: connectionError } = await supabase.from('connections')
                        .upsert({ user_1_id: ids[0], user_2_id: ids[1] }, { onConflict: 'user_1_id,user_2_id' });
                    if (connectionError) throw connectionError;

                    const respondedAt = new Date().toISOString();
                    const { error: requestError } = await supabase.from('connection_requests')
                        .update({ status: 'accepted', responded_at: respondedAt })
                        .eq('id', requestId);

                    if (requestError) {
                        await supabase.from('connections')
                            .delete()
                            .eq('user_1_id', ids[0])
                            .eq('user_2_id', ids[1]);
                        throw requestError;
                    }

                    // Force a contact refresh so the new friend pops up immediately
                    await refreshLocalCache(true);
                }
                setIncoming(prev => prev.filter(r => r.id !== requestId));
            } else if (action === 'reject') {
                await supabase.from('connection_requests')
                    .update({ status: 'rejected', responded_at: new Date().toISOString() })
                    .eq('id', requestId);
                setIncoming(prev => prev.filter(r => r.id !== requestId));
            } else if (action === 'cancel') {
                await supabase.from('connection_requests')
                    .delete()
                    .eq('id', requestId);
                setOutgoing(prev => prev.filter(r => r.id !== requestId));
            }
        } catch (err) {
            console.error(`[Requests] ${action} error:`, err);
            Alert.alert('Error', `Failed to ${action}`);
        } finally {
            setActionId(null);
        }
    };

    const onRefresh = () => {
        setRefreshing(true);
        fetchRequests();
    };

    const renderRequestItem = useCallback(({ item, isIncoming }: { item: any; isIncoming: boolean }) => {
        const user = isIncoming ? item.sender : item.receiver;
        return (
            <Animated.View entering={FadeInDown.duration(400)}>
                <View style={styles.requestCard}>
                    <GlassView intensity={25} tint="dark" style={styles.glassBackground} />
                    <View style={styles.cardContent}>
                        <SoulAvatar uri={proxySupabaseUrl(user?.avatar_url)} size={52} />
                        <View style={styles.userInfo}>
                            <Text style={styles.username}>{user?.username || 'Unknown'}</Text>
                            <Text style={styles.message} numberOfLines={1}>
                                {item.message || (isIncoming ? 'wants to connect' : 'Waiting for approval')}
                            </Text>
                        </View>
                        
                        {isIncoming ? (
                            <View style={styles.actionButtons}>
                                <TouchableOpacity 
                                    style={[styles.smallButton, { backgroundColor: activeTheme.primary }]} 
                                    onPress={() => handleAction(item.id, 'accept')}
                                    disabled={actionId === item.id}
                                >
                                    {actionId === item.id ? (
                                        <ActivityIndicator size="small" color="#fff" />
                                    ) : (
                                        <MaterialIcons name="check" size={20} color="#fff" />
                                    )}
                                </TouchableOpacity>
                                <TouchableOpacity 
                                    style={[styles.smallButton, { backgroundColor: 'rgba(255,255,255,0.08)' }]} 
                                    onPress={() => handleAction(item.id, 'reject')}
                                    disabled={actionId === item.id}
                                >
                                    <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.6)" />
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <TouchableOpacity 
                                style={styles.cancelButton} 
                                onPress={() => handleAction(item.id, 'cancel')}
                                disabled={actionId === item.id}
                            >
                                {actionId === item.id ? (
                                    <ActivityIndicator size="small" color="rgba(255,255,255,0.4)" />
                                ) : (
                                    <Text style={styles.cancelText}>Cancel</Text>
                                )}
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            </Animated.View>
        );
    }, [activeTheme, handleAction, actionId]);

    const renderSectionItem = useCallback(({ item: section }: { item: { title: string; data: any[] } }) => {
        if (section.data.length === 0) return null;
        
        return (
            <>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {section.data.map((req) => (
                    <React.Fragment key={req.id}>
                        {renderRequestItem({ item: req, isIncoming: section.title === 'Incoming' })}
                    </React.Fragment>
                ))}
            </>
        );
    }, [renderRequestItem]);

    return (
        <View style={styles.container}>
            <LinearGradient colors={['#000000', '#080808']} style={StyleSheet.absoluteFill} />
            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
                    <MaterialIcons name="arrow-back-ios" size={20} color="#fff" />
                </TouchableOpacity>
                <Text style={styles.title}>Requests</Text>
            </View>

            <FlatList
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={activeTheme.primary} />}
                data={[
                    { title: 'Incoming', data: incoming },
                    { title: 'Outgoing', data: outgoing }
                ]}
                renderItem={renderSectionItem}
                keyExtractor={item => item.title}
                contentContainerStyle={styles.list}
                ListHeaderComponent={
                    !loading && incoming.length === 0 && outgoing.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <View style={styles.emptyIconCircle}>
                                <MaterialIcons name="people-outline" size={42} color="rgba(255,255,255,0.15)" />
                            </View>
                            <Text style={styles.emptyTitle}>No pending requests</Text>
                            <Text style={styles.emptySubtitle}>Find other souls and start your story.</Text>
                            <TouchableOpacity style={styles.findButton} onPress={() => router.push('/search?context=soulmate')}>
                                <Text style={styles.findText}>Find People</Text>
                            </TouchableOpacity>
                        </View>
                    ) : null
                }
            />
            {loading && !refreshing && (
                <View style={styles.loader}>
                    <ActivityIndicator size="large" color={activeTheme.primary} />
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    header: { 
        flexDirection: 'row', 
        alignItems: 'center', 
        paddingTop: Platform.OS === 'ios' ? 60 : 40, 
        paddingHorizontal: 20, 
        marginBottom: 20,
        gap: 12
    },
    backButton: { 
        width: 44, 
        height: 44, 
        justifyContent: 'center', 
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)'
    },
    title: { color: '#fff', fontSize: 24, fontWeight: '800' },
    list: { paddingHorizontal: 20, paddingBottom: 60, flexGrow: 1 },
    sectionTitle: { 
        color: 'rgba(255,255,255,0.4)', 
        fontSize: 13, 
        fontWeight: '700', 
        textTransform: 'uppercase', 
        letterSpacing: 1, 
        marginBottom: 15, 
        marginTop: 10 
    },
    requestCard: { height: 84, borderRadius: 24, marginBottom: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
    glassBackground: { ...StyleSheet.absoluteFillObject },
    cardContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
    userInfo: { flex: 1, marginLeft: 16 },
    username: { color: '#fff', fontSize: 17, fontWeight: '700' },
    message: { color: 'rgba(255,255,255,0.4)', fontSize: 14, marginTop: 2 },
    actionButtons: { flexDirection: 'row', gap: 10 },
    smallButton: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
    cancelButton: { 
        backgroundColor: 'rgba(255,255,255,0.05)', 
        paddingHorizontal: 16, 
        paddingVertical: 10, 
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)'
    },
    cancelText: { color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '700' },
    emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 120, paddingHorizontal: 40 },
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
    emptyTitle: { color: 'rgba(255,255,255,0.4)', fontSize: 18, fontWeight: '700', marginBottom: 8 },
    emptySubtitle: { color: 'rgba(255,255,255,0.25)', fontSize: 14, fontWeight: '600', textAlign: 'center', marginBottom: 24 },
    findButton: { backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 28, paddingVertical: 14, borderRadius: 28, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
    findText: { color: '#fff', fontWeight: '700', fontSize: 15 },
    loader: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.8)' }
});
