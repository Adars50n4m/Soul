import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { SERVER_URL, serverFetch, proxySupabaseUrl } from '../config/api';
import { useApp } from '../context/AppContext';
import { MaterialIcons } from '@expo/vector-icons';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';

export default function RequestsScreen() {
    const { currentUser } = useApp();
    const [incoming, setIncoming] = useState<any[]>([]);
    const [outgoing, setOutgoing] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const router = useRouter();

    const fetchRequests = useCallback(async () => {
        try {
            const resp = await serverFetch(`${SERVER_URL}/api/connections/requests`, {
                headers: { 'x-user-id': currentUser?.id || '' }
            });
            const data = await resp.json() as any;
            if (data.success) {
                setIncoming(data.incoming || []);
                setOutgoing(data.outgoing || []);
            }
        } catch (err) {
            console.error('Fetch requests failed:', err);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [currentUser]);

    useEffect(() => {
        fetchRequests();
    }, [fetchRequests]);

    const handleAction = async (requestId: string, action: 'accept' | 'reject' | 'cancel') => {
        try {
            const method = action === 'cancel' ? 'DELETE' : 'PUT';
            const endpoint = `${SERVER_URL}/api/connections/request/${requestId}/${action}`;
            
            const resp = await serverFetch(endpoint, {
                method,
                headers: { 
                    'Content-Type': 'application/json',
                    'x-user-id': currentUser?.id || ''
                }
            });
            const data = await resp.json() as any;
            if (data.success) {
                // Remove from local state
                setIncoming(prev => prev.filter(r => r.id !== requestId));
                setOutgoing(prev => prev.filter(r => r.id !== requestId));
            }
        } catch (err) {
            console.error(`Request ${action} failed:`, err);
        }
    };

    const onRefresh = () => {
        setRefreshing(true);
        fetchRequests();
    };

    const renderRequestItem = ({ item, isIncoming }: { item: any; isIncoming: boolean }) => {
        const user = isIncoming ? item.sender : item.receiver;
        return (
            <Animated.View entering={FadeInDown.duration(400)}>
                <View style={styles.requestCard}>
                    <GlassView intensity={20} tint="dark" style={styles.glassBackground} />
                    <View style={styles.cardContent}>
                        <SoulAvatar uri={proxySupabaseUrl(user?.avatar_url)} size={48} />
                        <View style={styles.userInfo}>
                            <Text style={styles.username}>{user?.username || 'Unknown'}</Text>
                            <Text style={styles.message} numberOfLines={1}>
                                {item.message || (isIncoming ? 'wants to connect' : 'Waiting for approval')}
                            </Text>
                        </View>
                        
                        {isIncoming ? (
                            <View style={styles.actionButtons}>
                                <TouchableOpacity 
                                    style={[styles.smallButton, styles.acceptButton]} 
                                    onPress={() => handleAction(item.id, 'accept')}
                                >
                                    <MaterialIcons name="check" size={20} color="#fff" />
                                </TouchableOpacity>
                                <TouchableOpacity 
                                    style={[styles.smallButton, styles.rejectButton]} 
                                    onPress={() => handleAction(item.id, 'reject')}
                                >
                                    <MaterialIcons name="close" size={20} color="#fff" />
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <TouchableOpacity 
                                style={[styles.smallButton, styles.rejectButton]} 
                                onPress={() => handleAction(item.id, 'cancel')}
                            >
                                <Text style={styles.cancelText}>Cancel</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            </Animated.View>
        );
    };

    return (
        <View style={styles.container}>
            <LinearGradient colors={['#1a1a1a', '#000']} style={StyleSheet.absoluteFill} />
            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
                    <MaterialIcons name="arrow-back-ios" size={20} color="#fff" />
                </TouchableOpacity>
                <Text style={styles.title}>Soul Requests</Text>
            </View>

            <FlatList
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3b82f6" />}
                data={[
                    { title: 'Incoming', data: incoming },
                    { title: 'Outgoing', data: outgoing }
                ]}
                renderItem={({ item }) => (
                    <>
                        {item.data.length > 0 && <Text style={styles.sectionTitle}>{item.title}</Text>}
                        <FlatList
                            data={item.data}
                            renderItem={({ item: req }) => renderRequestItem({ item: req, isIncoming: item.title === 'Incoming' })}
                            keyExtractor={req => req.id}
                            scrollEnabled={false}
                        />
                    </>
                )}
                keyExtractor={item => item.title}
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                    !loading && incoming.length === 0 && outgoing.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <MaterialIcons name="people-outline" size={80} color="rgba(255,255,255,0.05)" />
                            <Text style={styles.emptyText}>No pending requests</Text>
                            <TouchableOpacity style={styles.findButton} onPress={() => router.push('/search')}>
                                <Text style={styles.findText}>Find People</Text>
                            </TouchableOpacity>
                        </View>
                    ) : null
                }
            />
            {loading && !refreshing && (
                <View style={styles.loader}>
                    <ActivityIndicator size="large" color="#3b82f6" />
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
        marginBottom: 20
    },
    backButton: { width: 44, height: 44, justifyContent: 'center' },
    title: { color: '#fff', fontSize: 24, fontWeight: '800', marginLeft: 10 },
    list: { paddingHorizontal: 20, paddingBottom: 40 },
    sectionTitle: { color: 'rgba(255,255,255,0.4)', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 15, marginTop: 10 },
    requestCard: { height: 76, borderRadius: 22, marginBottom: 12, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
    glassBackground: { ...StyleSheet.absoluteFillObject },
    cardContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 },
    userInfo: { flex: 1, marginLeft: 12 },
    username: { color: '#fff', fontSize: 16, fontWeight: '700' },
    message: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginTop: 2 },
    actionButtons: { flexDirection: 'row', gap: 8 },
    smallButton: { width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
    acceptButton: { backgroundColor: '#3b82f6' },
    rejectButton: { backgroundColor: 'rgba(255,255,255,0.1)' },
    cancelText: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '700', paddingHorizontal: 12 },
    emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 100 },
    emptyText: { color: 'rgba(255,255,255,0.2)', fontSize: 18, fontWeight: '600', marginTop: 20 },
    findButton: { marginTop: 20, backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
    findText: { color: '#fff', fontWeight: '700' },
    loader: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' }
});
