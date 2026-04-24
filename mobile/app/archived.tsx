import React, { useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  StatusBar,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { useApp } from '../context/AppContext';
import type { Contact } from '../types';

const formatTime = (ts?: string) => {
  if (!ts) return '';
  try {
    const date = new Date(ts);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
};

export default function ArchivedChatsScreen() {
  const router = useRouter();
  const { contacts, messages, activeTheme, archiveContact } = useApp();

  const archivedContacts = useMemo(() => {
    return contacts
      .filter((contact) => contact.isArchived)
      .map((contact) => {
        const chatMessages = messages?.[contact.id] || [];
        const lastMessage = chatMessages[chatMessages.length - 1];
        return {
          ...contact,
          previewText: lastMessage?.text || contact.lastMessage || 'No messages yet',
          previewTime: lastMessage?.timestamp || '',
        };
      })
      .sort((a, b) => {
        const aTime = a.previewTime ? new Date(a.previewTime).getTime() : 0;
        const bTime = b.previewTime ? new Date(b.previewTime).getTime() : 0;
        return bTime - aTime;
      });
  }, [contacts, messages]);

  const handleUnarchive = useCallback(async (contact: Contact) => {
    await archiveContact(contact.id, false);
  }, [archiveContact]);

  const renderItem = useCallback(({ item }: { item: Contact & { previewText: string; previewTime: string } }) => (
    <Pressable
      onPress={() => router.push(`/chat/${item.id}`)}
      onLongPress={() => {
        Alert.alert(item.name, undefined, [
          { text: 'Unarchive', onPress: () => handleUnarchive(item) },
          { text: 'Cancel', style: 'cancel' },
        ]);
      }}
      style={styles.row}
    >
      <GlassView intensity={30} tint="dark" style={styles.rowGlass} />
      <View style={styles.rowContent}>
        <SoulAvatar uri={item.localAvatarUri || item.avatar} size={54} />
        <View style={styles.textWrap}>
          <View style={styles.topLine}>
            <Text style={styles.name} numberOfLines={1}>{item.name || 'Unknown'}</Text>
            <Text style={styles.time}>{formatTime(item.previewTime)}</Text>
          </View>
          <Text style={styles.preview} numberOfLines={1}>{item.previewText}</Text>
        </View>
        <Pressable onPress={() => handleUnarchive(item)} style={styles.actionBtn}>
          <MaterialIcons name="unarchive" size={22} color={activeTheme.primary} />
        </Pressable>
      </View>
    </Pressable>
  ), [activeTheme.primary, handleUnarchive, router]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={['#000000', '#080808']} style={StyleSheet.absoluteFill} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back-ios" size={20} color="#fff" />
        </Pressable>
        <View>
          <Text style={styles.title}>Archived</Text>
          <Text style={styles.subtitle}>{archivedContacts.length} chats</Text>
        </View>
      </View>

      <FlatList
        data={archivedContacts}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <View style={styles.emptyIconCircle}>
                <MaterialIcons name="archive" size={42} color="rgba(255,255,255,0.15)" />
            </View>
            <Text style={styles.emptyTitle}>No archived chats</Text>
            <Text style={styles.emptyText}>Archived chats will stay here until you unarchive them.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingTop: 58,
    paddingBottom: 18,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '800',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    marginTop: 2,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    flexGrow: 1,
  },
  row: {
    marginBottom: 12,
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  rowGlass: {
    ...StyleSheet.absoluteFillObject,
  },
  rowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  textWrap: {
    flex: 1,
    marginLeft: 14,
    marginRight: 12,
  },
  topLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  name: {
    flex: 1,
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  time: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 12,
    fontWeight: '600',
  },
  preview: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.48)',
    fontSize: 14,
  },
  actionBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    marginTop: 140,
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
  emptyTitle: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.25)',
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
});
