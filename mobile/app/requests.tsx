import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, RefreshControl, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SERVER_URL, safeFetchJson, proxySupabaseUrl } from '../config/api';
import { useApp } from '../context/AppContext';
import { MaterialIcons } from '@expo/vector-icons';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';

export default function RequestsScreen() {
    const { currentUser, activeTheme } = useApp();
    const [incoming, setIncoming] = useState<any[]>([]);
    const [outgoing, setOutgoing] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [actionId, setActionId] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const router = useRouter();

    const fetchRequests = useCallback(async () => {
        setErrorMsg(null);
        try {
            const { success, data, error } = await safeFetchJson<any>(
                `${SERVER_URL}/api/connections/requests`,
                {
                    headers: { 'x-user-id': currentUser?.id || '' }
                }
            );

            if (success && data?.success) {
                setIncoming(data.incoming || []);
                setOutgoing(data.outgoing || []);
            } else {
                setErrorMsg(error || 'Could not load requests');
            }
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

    const handleAction = async (requestId: string, action: 'accept' | 'reject' | 'cancel') => {
        setActionId(requestId);
        try {
            const method = action === 'cancel' ? 'DELETE' : 'PUT';
            const endpoint = `${SERVER_URL}/api/connections/request/${requestId}/${action}`;
            
            const { success, error } = await safeFetchJson<any>(endpoint, {
                method,
                headers: { 
                    'Content-Type': 'application/json',
                    'x-user-id': currentUser?.id || ''
                }
            });

            if (success) {
                setIncoming(prev => prev.filter(r => r.id !== requestId));
                setOutgoing(prev => prev.filter(r => r.id !== requestId));
            } else {
                Alert.alert('Error', error || `Failed to ${action}`);
            }
        } catch (err) {
            console.error(`[Requests] ${action} error:`, err);
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
    emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 100 },
    emptyText: { color: 'rgba(255,255,255,0.2)', fontSize: 18, fontWeight: '600', marginTop: 20 },
    findButton: { marginTop: 20, backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
    findText: { color: '#fff', fontWeight: '700' },
    loader: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.8)' }
});
