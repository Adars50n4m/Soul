import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
  Alert,
  KeyboardAvoidingView,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../context/AppContext';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { proxySupabaseUrl } from '../config/api';
import { supabase } from '../config/supabase';
import { Contact } from '../types';
import { hapticService } from '../services/HapticService';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { storageService } from '../services/StorageService';

export default function CreateGroupScreen() {
    const router = useRouter();
    const { contacts, currentUser, activeTheme, offlineService, refreshLocalCache } = useApp();
    
    const [step, setStep] = useState<1 | 2>(1);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [groupName, setGroupName] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [groupAvatar, setGroupAvatar] = useState<string | null>(null);

    // Filter contacts based on search query
    const filteredContacts = useMemo(() => {
        return contacts.filter(c => 
            !c.isGroup && 
            (c.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
             c.id.toLowerCase().includes(searchQuery.toLowerCase()))
        );
    }, [contacts, searchQuery]);

    const toggleUser = (id: string) => {
        hapticService.impact(Haptics.ImpactFeedbackStyle.Light);
        setSelectedIds(prev => 
            prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
        );
    };

    const handlePickAvatar = async () => {
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.7,
        });

        if (!result.canceled) {
            setGroupAvatar(result.assets[0].uri);
        }
    };

    const handleCreateGroup = async () => {
        if (!groupName.trim()) {
            Alert.alert('Group Name', 'Please enter a name for your group');
            return;
        }

        setIsCreating(true);
        try {
            let uploadedAvatarUrl = groupAvatar;
            
            // 0. Upload Avatar if selected
            if (groupAvatar && !groupAvatar.startsWith('http')) {
                const storageKey = await storageService.uploadImage(groupAvatar, 'profiles', 'groups');
                if (storageKey) {
                    uploadedAvatarUrl = storageKey;
                }
            }

            // 1. Create group in Supabase
            const { data: groupData, error: groupError } = await supabase
                .from('groups')
                .insert({
                    name: groupName.trim(),
                    created_by: currentUser?.id,
                    avatar_url: uploadedAvatarUrl,
                })
                .select()
                .single();

            if (groupError) throw groupError;

            // 2. Add members
            const memberRows = [
                { group_id: groupData.id, user_id: currentUser?.id, role: 'admin' },
                ...selectedIds.map(id => ({ group_id: groupData.id, user_id: id, role: 'member' }))
            ];

            const { error: memberError } = await supabase
                .from('group_members')
                .insert(memberRows);

            if (memberError) throw memberError;

            // 3. Save locally
            await offlineService.saveGroup({
                id: groupData.id,
                name: groupName.trim(),
                description: '',
                avatarUrl: uploadedAvatarUrl || '',
                createdBy: currentUser?.id,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });

            // 4. Also save participants locally for faster lookup
            const localMembers = memberRows.map(m => ({
                id: `${groupData.id}_${m.user_id}`,
                groupId: groupData.id,
                userId: m.user_id,
                role: m.role as string,
                joinedAt: new Date().toISOString()
            }));
            await offlineService.saveGroupMembers(groupData.id, localMembers);

            // 5. Refresh and navigate
            await refreshLocalCache();
            hapticService.notification(Haptics.NotificationFeedbackType.Success);
            router.replace(`/chat/${groupData.id}`);
            
        } catch (error: any) {
            console.error('[CreateGroup] Error:', error);
            Alert.alert('Error', error.message || 'Failed to create group');
        } finally {
            setIsCreating(false);
        }
    };

    const renderContactItem = ({ item }: { item: Contact }) => {
        const isSelected = selectedIds.includes(item.id);
        return (
            <Pressable 
                style={styles.contactItem} 
                onPress={() => toggleUser(item.id)}
            >
                <View style={styles.contactAvatarContainer}>
                    <SoulAvatar uri={proxySupabaseUrl(item.avatar)} size={50} />
                    {isSelected && (
                        <View style={[styles.checkBadge, { backgroundColor: activeTheme.primary }]}>
                            <MaterialIcons name="check" size={12} color="#fff" />
                        </View>
                    )}
                </View>
                <View style={styles.contactInfo}>
                    <Text style={styles.contactName}>{item.name}</Text>
                    <Text style={styles.contactStatus}>{item.status}</Text>
                </View>
                <View style={[styles.checkbox, isSelected && { backgroundColor: activeTheme.primary, borderColor: activeTheme.primary }]}>
                    {isSelected && <MaterialIcons name="check" size={16} color="#fff" />}
                </View>
            </Pressable>
        );
    };

    if (step === 2) {
        return (
            <KeyboardAvoidingView 
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.container}
            >
                <LinearGradient colors={['#000', '#080808']} style={StyleSheet.absoluteFill} />
                
                <View style={styles.header}>
                    <Pressable onPress={() => setStep(1)} style={styles.backButton}>
                        <MaterialIcons name="arrow-back-ios" size={20} color="#fff" />
                    </Pressable>
                    <Text style={styles.headerTitle}>New Group</Text>
                    <View style={{ width: 44 }} />
                </View>

                <View style={styles.content}>
                    <Pressable style={styles.avatarPicker} onPress={handlePickAvatar}>
                        <GlassView intensity={20} tint="light" style={styles.avatarGlass}>
                            {groupAvatar ? (
                                <SoulAvatar uri={groupAvatar} size={100} />
                            ) : (
                                <MaterialIcons name="photo-camera" size={40} color="rgba(255,255,255,0.4)" />
                            )}
                        </GlassView>
                        <Text style={styles.avatarPickerText}>Set Group Icon</Text>
                    </Pressable>

                    <View style={styles.inputContainer}>
                        <GlassView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
                        <TextInput
                            style={styles.input}
                            placeholder="Group Name"
                            placeholderTextColor="rgba(255,255,255,0.4)"
                            value={groupName}
                            onChangeText={setGroupName}
                            autoFocus
                        />
                    </View>
                    
                    <Text style={styles.memberCountText}>
                        {selectedIds.length} members selected
                    </Text>

                    <View style={styles.selectedGrid}>
                        {selectedIds.slice(0, 5).map(id => {
                            const contact = contacts.find(c => c.id === id);
                            return (
                                <View key={id} style={styles.miniAvatar}>
                                    <SoulAvatar uri={proxySupabaseUrl(contact?.avatar)} size={40} />
                                </View>
                            );
                        })}
                        {selectedIds.length > 5 && (
                            <View style={styles.moreCount}>
                                <Text style={styles.moreCountText}>+{selectedIds.length - 5}</Text>
                            </View>
                        )}
                    </View>
                </View>

                <Pressable 
                    onPress={handleCreateGroup} 
                    disabled={isCreating || !groupName.trim()}
                    style={styles.createButtonContainer}
                >
                    <LinearGradient 
                        colors={isCreating || !groupName.trim() ? ['#333', '#222'] : [activeTheme.primary, activeTheme.accent]} 
                        style={styles.createButton}
                    >
                        {isCreating ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.createButtonText}>Create Group</Text>
                        )}
                    </LinearGradient>
                </Pressable>
            </KeyboardAvoidingView>
        );
    }

    return (
        <View style={styles.container}>
            <LinearGradient colors={['#000', '#080808']} style={StyleSheet.absoluteFill} />
            
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton}>
                    <MaterialIcons name="close" size={24} color="#fff" />
                </Pressable>
                <View style={styles.headerInfo}>
                    <Text style={styles.headerTitle}>Add Members</Text>
                    <Text style={styles.headerSubtitle}>{selectedIds.length} selected</Text>
                </View>
                <Pressable 
                    onPress={() => setStep(2)} 
                    disabled={selectedIds.length === 0}
                    style={[styles.nextButton, selectedIds.length === 0 && { opacity: 0.5 }]}
                >
                    <Text style={[styles.nextButtonText, { color: activeTheme.primary }]}>Next</Text>
                </Pressable>
            </View>

            <View style={styles.searchBar}>
                <GlassView intensity={20} tint="dark" style={StyleSheet.absoluteFill} />
                <MaterialIcons name="search" size={20} color="rgba(255,255,255,0.4)" style={{ marginLeft: 15 }} />
                <TextInput
                    style={styles.searchInput}
                    placeholder="Find friends to add..."
                    placeholderTextColor="rgba(255,255,255,0.4)"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                />
            </View>

            <FlashList
                data={filteredContacts}
                renderItem={renderContactItem}
                keyExtractor={item => item.id}
                estimatedItemSize={70}
                contentContainerStyle={{ paddingBottom: 100 }}
                ListEmptyComponent={
                    <View style={styles.emptyState}>
                        <MaterialIcons name="person-off" size={60} color="rgba(255,255,255,0.1)" />
                        <Text style={styles.emptyText}>No contacts found</Text>
                    </View>
                }
            />

            {selectedIds.length > 0 && (
                <View style={styles.footerPanel}>
                    <GlassView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
                    <FlashList
                        horizontal
                        data={selectedIds}
                        renderItem={({ item }) => {
                            const contact = contacts.find(c => c.id === item);
                            return (
                                <Pressable style={styles.footerAvatarItem} onPress={() => toggleUser(item)}>
                                    <SoulAvatar uri={proxySupabaseUrl(contact?.avatar)} size={44} />
                                    <View style={styles.removeIcon}>
                                        <MaterialIcons name="close" size={10} color="#fff" />
                                    </View>
                                </Pressable>
                            );
                        }}
                        keyExtractor={item => item}
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ paddingHorizontal: 20 }}
                    />
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
        paddingBottom: 15,
        justifyContent: 'space-between'
    },
    backButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.05)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerInfo: { alignItems: 'center' },
    headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
    headerSubtitle: { color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 2 },
    nextButton: { paddingHorizontal: 16, paddingVertical: 8 },
    nextButtonText: { fontSize: 16, fontWeight: '700' },
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        height: 46,
        marginHorizontal: 20,
        borderRadius: 23,
        overflow: 'hidden',
        marginBottom: 10,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    searchInput: { flex: 1, height: '100%', color: '#fff', paddingHorizontal: 12, fontSize: 15 },
    contactItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 10,
    },
    contactAvatarContainer: { position: 'relative' },
    checkBadge: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 2,
        borderColor: '#000',
        alignItems: 'center',
        justifyContent: 'center',
    },
    contactInfo: { flex: 1, marginLeft: 15 },
    contactName: { color: '#fff', fontSize: 16, fontWeight: '600' },
    contactStatus: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginTop: 2 },
    checkbox: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.2)',
        alignItems: 'center',
        justifyContent: 'center'
    },
    content: { flex: 1, alignItems: 'center', paddingTop: 40, paddingHorizontal: 30 },
    avatarPicker: { alignItems: 'center', marginBottom: 40 },
    avatarGlass: {
        width: 100,
        height: 100,
        borderRadius: 50,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)'
    },
    avatarPickerText: { color: 'rgba(255,255,255,0.5)', marginTop: 12, fontWeight: '600' },
    inputContainer: {
        width: '100%',
        height: 56,
        borderRadius: 16,
        overflow: 'hidden',
        marginBottom: 20,
    },
    input: { flex: 1, paddingHorizontal: 20, color: '#fff', fontSize: 18, fontWeight: '500' },
    memberCountText: { color: 'rgba(255,255,255,0.4)', marginBottom: 20, fontWeight: '600' },
    selectedGrid: { flexDirection: 'row', gap: -15 },
    miniAvatar: { borderRadius: 20, borderWidth: 2, borderColor: '#000' },
    moreCount: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: '#222',
        borderWidth: 2,
        borderColor: '#000',
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: -15
    },
    moreCountText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    createButtonContainer: {
        paddingHorizontal: 20,
        paddingBottom: Platform.OS === 'ios' ? 40 : 20,
    },
    createButton: {
        height: 56,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#3b82f6',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 4
    },
    createButtonText: { color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: 0.5 },
    footerPanel: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 100,
        paddingTop: 15,
        borderTopWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        overflow: 'hidden'
    },
    footerAvatarItem: { marginRight: 15, position: 'relative' },
    removeIcon: {
        position: 'absolute',
        top: -4,
        right: -4,
        backgroundColor: '#ff4444',
        width: 16,
        height: 16,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: '#000'
    },
    emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 100 },
    emptyText: { color: 'rgba(255,255,255,0.2)', marginTop: 16, fontSize: 16, fontWeight: '500' },
});
