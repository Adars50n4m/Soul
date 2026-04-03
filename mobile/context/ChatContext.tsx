import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../config/supabase';
import { proxySupabaseUrl, SERVER_URL, safeFetchJson } from '../config/api';
import { chatService, type ChatMessage } from '../services/ChatService';
import { offlineService, type QueuedMessage } from '../services/LocalDBService';
import { soulFolderService } from '../services/SoulFolderService';
import { useAuth } from './AuthContext';
import { type Contact, type Message } from '../types';

import { normalizeId, getSuperuserName, LEGACY_TO_UUID, isWithinEditWindow } from '../utils/idNormalization';
import { Alert } from 'react-native';
import { syncAvatar } from '../services/MediaDownloadService';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ChatContextType {
  contacts: Contact[];
  messages: Record<string, Message[]>;
  onlineUsers: string[];
  typingUsers: string[];
  otherUser: any | null;
  connectivity: {
    isDeviceOnline: boolean;
    isServerReachable: boolean;
    isRealtimeConnected: boolean;
  };
  setOtherUser: (user: any) => void;
  addMessage: (chatId: string, text: string, media?: Message['media'], replyTo?: string) => Promise<void>;
  sendChatMessage: (chatId: string, text: string, media?: Message['media'], replyTo?: string, localUri?: string) => Promise<void>;
  updateMessage: (chatId: string, messageId: string, updates: Partial<Message>) => Promise<void>;
  addReaction: (chatId: string, messageId: string, emoji: string | null) => Promise<void>;
  deleteMessage: (chatId: string, messageId: string) => Promise<void>;
  toggleHeart: (chatId: string, messageId: string) => Promise<void>;
  sendTyping: (isTyping: boolean) => void;
  clearChatMessages: (partnerId: string) => Promise<void>;
  fetchOtherUserProfile: (userId: string) => Promise<void>;
  initializeChatSession: (partnerId: string) => Promise<void>;
  cleanupChatSession: (partnerId?: string) => void;
  refreshLocalCache: () => Promise<void>;
  uploadProgressTracker: Record<string, number>;
  archiveContact: (partnerId: string, archive?: boolean) => Promise<void>;
  unfriendContact: (partnerId: string) => Promise<void>;
}

export const ChatContext = createContext<ChatContextType | undefined>(undefined);

function mapQueuedMessage(row: QueuedMessage): Message {
  return {
    id: row.id,
    sender: row.sender,
    text: row.text ?? '',
    timestamp: row.timestamp,
    status: row.status,
    media: row.media,
    replyTo: row.replyTo,
    localFileUri: row.localFileUri,
  };
}

function mapLocalContact(row: any): Contact {
  return {
    ...normalizeContact(row),
    isArchived: row.is_archived === 1
  };
}

function mapChatMessage(message: ChatMessage, currentUserId: string): Message {
  return {
    id: message.id,
    sender: message.sender_id === currentUserId ? 'me' : 'them',
    text: message.text ?? '',
    timestamp: message.timestamp,
    status: message.status,
    reactions: message.reactions,
    replyTo: message.reply_to,
    media: message.media,
    localFileUri: message.localFileUri,
  };
}

function normalizeContact(row: any): Contact {
  const superuserName = getSuperuserName(row.id);
  const name = superuserName || row.display_name || row.full_name || row.name || row.username || (row.id ? `@${row.id.substring(0, 5)}` : 'User');
  return {
    id: row.id,
    name: name,
    avatar: row.avatar_url || row.avatar || '',
    status: row.status ?? 'offline',
    lastMessage: row.lastMessage ?? row.last_message ?? '',
    unreadCount: row.unreadCount ?? row.unread_count ?? 0,
    about: row.about ?? row.bio ?? '',
    avatarType: row.avatar_type || row.avatarType || 'default',
    lastSeen: row.lastSeen ?? row.last_seen ?? undefined,
    last_updated_at: row.updated_at || row.updatedAt || undefined,
    localAvatarUri: row.local_avatar_uri || row.localAvatarUri || undefined,
    avatarUpdatedAt: row.avatar_updated_at || row.avatarUpdatedAt || undefined,
  };
}

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentUser } = useAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [uploadProgressTracker, setUploadProgressTracker] = useState<Record<string, number>>({});
  const [otherUser, setOtherUser] = useState<any | null>(null);
  const [connectivity, setConnectivity] = useState(() => chatService.getConnectivityState());
  const presenceChannelRef = useRef<any>(null);
  const activeChatIdRef = useRef<string | null>(null);
  const lastServerSyncRef = useRef<number>(0);

  const contactsRef = useRef<Contact[]>([]);

  const hydrateFromLocalDb = useCallback(async (passedUserId?: string) => {
    try {
      const hydrationTimeout = 5000;
      const start = Date.now();
      await Promise.race([
        offlineService.initialize(),
        soulFolderService.init(),
        new Promise<void>((resolve) => setTimeout(() => {
          console.warn(`[ChatContext] Offline DB/Folder init timed out after ${Date.now() - start}ms, moving on`);
          resolve();
        }, hydrationTimeout))
      ]);

      // FIX: Migrate legacy IDs (shri, hari) to UUIDs so history is preserved
      await offlineService.migrateLegacyIds(LEGACY_TO_UUID);
      
      // Perform one-time migration of old media files if needed (in background)
      soulFolderService.migrateFromOldCache().catch(() => {});
      soulFolderService.migrateOldStorageServiceFiles().catch(() => {});
      
    } catch (e) {
      console.warn('[ChatContext] Offline init failed:', e);
    }

    try {
      const dbQueryTimeout = 15000;

      // Phase 1: Contacts (INSTANT) - Fix for blank screen on refresh
      const localContacts = await Promise.race([
        offlineService.getContacts(),
        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), dbQueryTimeout))
      ]) as any[];

      if (localContacts && localContacts.length > 0) {
        // ROBUST FILTERING: If currentUser is not yet available, try to get ID from AsyncStorage
        let myUuid = passedUserId || currentUser?.id;
        if (!myUuid) {
          const cachedId = await require('@react-native-async-storage/async-storage').default.getItem('ss_current_user');
          if (cachedId) myUuid = cachedId;
        }

        const normalized = localContacts
          .map(mapLocalContact)
          .filter(c => {
            if (!myUuid) return true;
            const cid = LEGACY_TO_UUID[c.id] || c.id;
            const mid = LEGACY_TO_UUID[myUuid] || myUuid;
            
            // If we found the user's ID in the local DB, PURGE IT permanently.
            if (cid === mid) {
              offlineService.deleteContact(c.id).catch(() => {}); // Purge ghost contact
              return false;
            }
            return true;
          });

        contactsRef.current = normalized;
        setContacts(normalized);
        console.log(`[ChatContext] Instant hydration: ${normalized.length} contacts (filtered self: ${!!myUuid})`);
      }

      // Phase 2: Messages (Async)
      const localMessages = await Promise.race([
        offlineService.getAllMessages(),
        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), dbQueryTimeout))
      ]) as any[];

      const grouped = (localMessages || []).reduce((acc: Record<string, Message[]>, row: any) => {
        const normalizedChatId = LEGACY_TO_UUID[row.chatId] || row.chatId;
        if (!acc[normalizedChatId]) acc[normalizedChatId] = [];
        acc[normalizedChatId].push(mapQueuedMessage(row));
        return acc;
      }, {});

      (Object.values(grouped) as Message[][]).forEach((chatRows) => {
        chatRows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      });

      setMessages(grouped);
    } catch (e) {
      console.warn('[ChatContext] hydrateFromLocalDb error:', e);
    }
  }, []);

  const refreshContactsFromServer = useCallback(async () => {
    if (!currentUser) return;

    // Phase 1: Instant local load
    await hydrateFromLocalDb(currentUser.id);

    // Phase 2: Background network sync with 5-minute throttling
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;
    
    // Read from AsyncStorage if ref is 0 (first run since app start)
    if (lastServerSyncRef.current === 0) {
      const saved = await AsyncStorage.getItem('ss_last_contact_sync');
      if (saved) lastServerSyncRef.current = parseInt(saved, 10);
    }

    if (now - lastServerSyncRef.current < FIVE_MINUTES) {
      console.log('[ChatContext] Skipping server refresh (synced recently)');
      return;
    }

    (async () => {
      try {
        const myUuid = LEGACY_TO_UUID[currentUser.id] || currentUser.id;
        let allVisibleProfiles: any[] = [];
        let serverSuccess = false;

        // 1. Try server API
        try {
          const { success, data } = await safeFetchJson<any>(`${SERVER_URL}/api/connections`, {
            headers: { 'x-user-id': currentUser.id }
          });
          if (success && data?.success) {
            allVisibleProfiles = data.connections || [];
            serverSuccess = true;
          }
        } catch (err) {
          console.warn('[ChatContext] Server refresh failed');
        }

        // 2. Fallback to direct Supabase if needed
        if (!serverSuccess) {
          const { data: conns } = await supabase.from('connections')
            .select('user_1_id, user_2_id')
            .or(`user_1_id.eq.${myUuid},user_2_id.eq.${myUuid}`);

          if (conns) {
            const otherIds = conns.map(c => c.user_1_id === myUuid ? c.user_2_id : c.user_1_id);
            const { data: profiles } = await supabase.from('profiles').select('*').in('id', otherIds);
            if (profiles) allVisibleProfiles = profiles;
          }
        }

        // 3. Superuser visibility
        const superUserIds = Object.values(LEGACY_TO_UUID);
        if (superUserIds.includes(myUuid)) {
          const otherSuperUserId = superUserIds.find(id => id !== myUuid);
          if (otherSuperUserId && !allVisibleProfiles.some(u => u.id === otherSuperUserId)) {
            const { data: profile } = await supabase.from('profiles').select('*').eq('id', otherSuperUserId).maybeSingle();
            if (profile) allVisibleProfiles.push(profile);
            else {
              allVisibleProfiles.push({
                id: otherSuperUserId,
                username: otherSuperUserId === LEGACY_TO_UUID['shri'] ? 'shri' : 'hari',
                display_name: otherSuperUserId === LEGACY_TO_UUID['shri'] ? 'Shri' : 'Hari',
                avatar_type: 'teddy'
              });
            }
          }
        }

        if (allVisibleProfiles.length > 0) {
          const normalized = allVisibleProfiles
            .filter(p => {
              const pId = LEGACY_TO_UUID[p.id] || p.id;
              return pId !== myUuid;
            })
            .map(normalizeContact);
          contactsRef.current = normalized;
          setContacts(normalized);
          
          for (const profile of allVisibleProfiles) {
            const primaryId = LEGACY_TO_UUID[profile.id] || profile.id;
            if (primaryId === myUuid) continue; 
            
            const existing = contactsRef.current.find(c => c.id === primaryId);
            const avatarUrl = profile.avatar_url || existing?.avatar || '';
            const updatedAt = profile.updated_at || existing?.last_updated_at || new Date().toISOString();

            // Background sync the avatar file
            if (avatarUrl) {
              syncAvatar(primaryId, avatarUrl, updatedAt).then(localUri => {
                if (localUri) {
                  setContacts(prev => prev.map(c => 
                    c.id === primaryId ? { ...c, localAvatarUri: localUri } : c
                  ));
                }
              }).catch(() => {});
            }

            await offlineService.saveContact({
              id: primaryId,
              name: profile.display_name || profile.username || 'User',
              avatar: avatarUrl,
              avatarType: profile.avatar_type || existing?.avatarType || 'default',
              status: existing?.status || 'offline',
              lastMessage: existing?.lastMessage || '',
              unreadCount: existing?.unreadCount || 0,
              updatedAt: updatedAt
            });
          }
          lastServerSyncRef.current = Date.now();
          AsyncStorage.setItem('ss_last_contact_sync', lastServerSyncRef.current.toString()).catch(() => {});
        }
      } catch (e) {
        console.warn('[ChatContext] Background refresh error:', e);
      }
    })();
  }, [currentUser, hydrateFromLocalDb]);

  useEffect(() => {
    if (!currentUser) {
      contactsRef.current = [];
      setContacts([]);
      setMessages({});
      setTypingUsers([]);
      setOnlineUsers([]);
      activeChatIdRef.current = null;
      chatService.cleanup();
      return;
    }

    let cancelled = false;

    (async () => {
      await hydrateFromLocalDb(currentUser.id);
      if (!cancelled) {
        await refreshContactsFromServer();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentUser, hydrateFromLocalDb, refreshContactsFromServer]);

  /**
   * Smart Merge: Preservation of local-only state (like localFileUri)
   */
  const upsertMessage = useCallback((partnerId: string, nextMessage: Message) => {
    setMessages((prev) => {
      const current = prev[partnerId] || [];
      const index = current.findIndex((item) => item.id === nextMessage.id);
      
      let updated;
      if (index !== -1) {
        const existing = current[index];
        // CRITICAL FIX: Merge updates but PRESERVE localFileUri if nextMessage doesn't have it
        // This is where most "re-download" issues happen!
        updated = [...current];
        updated[index] = {
          ...existing,
          ...nextMessage,
          localFileUri: nextMessage.localFileUri || existing.localFileUri,
          thumbnailUri: nextMessage.thumbnailUri || existing.thumbnailUri
        };
      } else {
        updated = [...current, nextMessage];
      }

      updated.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      return { ...prev, [partnerId]: updated };
    });
  }, []);

  const updateContactPreview = useCallback((partnerId: string, message: Message) => {
    const preview = message.text?.trim() || (message.media ? 'Media' : '');

    setContacts((prev) => {
      const existing = prev.find((contact) => contact.id === partnerId);
      if (!existing) return prev;

      const unreadDelta =
        message.sender === 'them' && activeChatIdRef.current !== partnerId ? 1 : 0;

      return prev.map((contact) =>
        contact.id === partnerId
          ? {
              ...contact,
              lastMessage: preview,
              unreadCount: Math.max(0, (contact.unreadCount || 0) + unreadDelta),
            }
          : contact
      );
    });
  }, []);

  /**
   * Improved incoming message handling with database verification
   */
  const handleIncomingMessage = useCallback(async (message: ChatMessage) => {
    if (!currentUser) return;

    const partnerId = message.sender_id === currentUser.id ? message.receiver_id : message.sender_id;
    const normalized = mapChatMessage(message, currentUser.id);

    // FIX Root Cause: Before updating state, check if we already have a localFileUri in SQLite
    if (normalized.media && !normalized.localFileUri) {
      const localPath = await offlineService.getMediaDownload(normalized.id);
      if (localPath) {
        normalized.localFileUri = localPath;
        console.log(`[ChatContext] Restored path from DB for ${normalized.id}: ${localPath}`);
      }
    }

    upsertMessage(partnerId, normalized);
    updateContactPreview(partnerId, normalized);
  }, [currentUser, updateContactPreview, upsertMessage]);

  const handleStatusUpdate = useCallback((messageId: string, status: ChatMessage['status'], newId?: string) => {
    setMessages((prev) => {
      const nextState = { ...prev };
      for (const chatId of Object.keys(nextState)) {
        const chatRows = nextState[chatId];
        const hasMatch = chatRows.some((message) => message.id === messageId || (!!newId && message.id === newId));
        if (!hasMatch) continue;

        nextState[chatId] = chatRows.map((message) => {
          if (message.id !== messageId && (!newId || message.id !== newId)) {
            return message;
          }
          return {
            ...message,
            id: newId && message.id === messageId ? newId : message.id,
            status,
          };
        });
      }
      return nextState;
    });
  }, []);

  const handleRemoteDelete = useCallback((messageId: string) => {
    console.log(`[ChatContext] Handling remote delete for ${messageId}`);
    setMessages((prev) => {
      const nextState = { ...prev };
      for (const chatId of Object.keys(nextState)) {
        nextState[chatId] = (nextState[chatId] || []).filter(m => m.id !== messageId);
      }
      return nextState;
    });
  }, []);

  const initializeChatSession = useCallback(async (partnerId: string) => {
    if (!currentUser) return;
    activeChatIdRef.current = partnerId;

    // Load from SQLite first for instant responsiveness
    const existingMessages = await offlineService.getMessages(partnerId, 500);
    setMessages((prev) => ({
      ...prev,
      [partnerId]: existingMessages.map(mapQueuedMessage),
    }));

    // Start network session (syncs with Supabase)
    await chatService.initialize(
      currentUser.id,
      partnerId,
      currentUser.name,
      handleIncomingMessage,
      handleStatusUpdate,
      () => setConnectivity(chatService.getConnectivityState()),
      (msgId, progress) => {
        setUploadProgressTracker(prev => ({ ...prev, [msgId]: progress }));
      },
      undefined, // onAcknowledgment
      handleRemoteDelete
    );
    setConnectivity(chatService.getConnectivityState());
  }, [currentUser, handleIncomingMessage, handleStatusUpdate]);

  const cleanupChatSession = useCallback((partnerId?: string) => {
    if (!partnerId || activeChatIdRef.current === partnerId) {
      activeChatIdRef.current = null;
      chatService.cleanup();
      setConnectivity(chatService.getConnectivityState());
    }
  }, []);

  useEffect(() => {
    if (!currentUser) return;

    const channel = supabase.channel('presence-global', {
      config: { presence: { key: currentUser.id } },
    });
    presenceChannelRef.current = channel;

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const users = new Set<string>();
      Object.values(state).forEach((presences: any) => {
        presences.forEach((presence: any) => {
          if (presence.user_id) users.add(presence.user_id);
        });
      });
      const uniqueUsers = Array.from(users);
      setOnlineUsers(uniqueUsers);
      setContacts((prev) =>
        prev.map((contact) => ({
          ...contact,
          status: uniqueUsers.includes(contact.id) ? 'online' : 'offline',
        }))
      );
    });

    channel.on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (payload.userId !== currentUser.id) {
        setTypingUsers((prev) => Array.from(new Set([...prev, payload.userId])));
      }
    });

    channel.on('broadcast', { event: 'stop-typing' }, ({ payload }) => {
      setTypingUsers((prev) => prev.filter((id) => id !== payload.userId));
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ user_id: currentUser.id, online_at: new Date().toISOString() });
      }
    });

    // --- REAL-TIME PROFILE UPDATES (DP, Name, Note) ---
    const profileChannel = supabase
      .channel('profile-sync-global')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles' },
        (payload) => {
          const updated = payload.new as any;
          const updatedId = LEGACY_TO_UUID[updated.id] || updated.id;
          const myPrimaryId = LEGACY_TO_UUID[currentUser.id] || currentUser.id;
          
          if (updatedId === myPrimaryId) return; // Ignore own changes (AuthContext handles them)

          setContacts((prev) => {
            const index = prev.findIndex(c => (LEGACY_TO_UUID[c.id] || c.id) === updatedId);
            if (index === -1) return prev; // Not in my contacts

            const existing = prev[index];
            
            // VALIDATION: Only update if the incoming timestamp is newer
            const existingTs = existing.last_updated_at ? new Date(existing.last_updated_at).getTime() : 0;
            const newTs = updated.updated_at ? new Date(updated.updated_at).getTime() : 0;
            
            if (newTs <= existingTs && existingTs !== 0) {
                console.log(`[ChatContext] Skipping profile update for ${updated.id} (already up-to-date)`);
                return prev;
            }

            console.log(`[ChatContext] Real-time profile update for ${updated.id}: ${updated.display_name || updated.username}`);
            
            const next = [...prev];
            const normalized = normalizeContact(updated);
            next[index] = {
                ...existing,
                ...normalized,
                last_updated_at: updated.updated_at
            };

            // PERSIST TO SQLITE
            offlineService.saveContact({
                id: updated.id,
                name: updated.display_name || updated.username || 'User',
                avatar: updated.avatar_url || '',
                avatarType: updated.avatar_type || 'default',
                status: existing.status,
                lastMessage: existing.lastMessage,
                unreadCount: existing.unreadCount,
                about: updated.bio || '',
                updatedAt: updated.updated_at,
                note: updated.note,
                noteTimestamp: updated.note_timestamp
            }).then(() => {
                // Background sync the avatar file for real-time updates
                if (updated.avatar_url) {
                    syncAvatar(updated.id, updated.avatar_url, updated.updated_at).then(localUri => {
                        if (localUri) {
                            setContacts(prevContacts => prevContacts.map(c => 
                                (LEGACY_TO_UUID[c.id] || c.id) === updatedId ? { ...c, localAvatarUri: localUri } : c
                            ));
                            offlineService.updateContactAvatar(updated.id, localUri, updated.updated_at).catch(() => {});
                        }
                    }).catch(e => console.warn('[ChatContext] Avatar sync failed for real-time update:', e));
                }
            }).catch(e => console.warn('[ChatContext] Failed to persist real-time profile update:', e));

            return next;
          });
        }
      )
      .subscribe();

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
      if (profileChannel) {
        supabase.removeChannel(profileChannel);
      }
    };
  }, [currentUser]);

  const sendChatMessage = useCallback(async (chatId: string, text: string, media?: Message['media'], replyTo?: string, localUri?: string) => {
    if (!currentUser) return;
    if (activeChatIdRef.current !== chatId) {
      await initializeChatSession(chatId);
    }

    const sent = await chatService.sendMessage(chatId, text, media, replyTo, localUri);
    if (sent) {
      const normalized = mapChatMessage(sent, currentUser.id);
      upsertMessage(chatId, normalized);
      updateContactPreview(chatId, normalized);
    }
  }, [currentUser, initializeChatSession, updateContactPreview, upsertMessage]);

  const updateMessage = useCallback(async (chatId: string, messageId: string, updates: Partial<Message>) => {
    if (!chatId) return;
    
    const current = messages[chatId]?.find(m => m.id === messageId);
    if (current && !isWithinEditWindow(current.timestamp)) {
      Alert.alert('Time Limit Exceeded', 'You can only edit messages within 5 minutes of sending.');
      return;
    }
    
    setMessages((prev) => {
      const chatMsgs = prev[chatId];
      if (!chatMsgs) return prev;
      
      return {
        ...prev,
        [chatId]: chatMsgs.map((message) =>
          message.id === messageId
              ? {
                ...message,
                ...updates,
                ...(typeof updates.text === 'string' ? { editedAt: new Date().toISOString() } : {}),
                media: message.media
                  ? {
                      ...message.media,
                      ...(updates.media || {}),
                      ...(typeof updates.text === 'string' ? { caption: updates.text || undefined } : {}),
                    }
                  : updates.media,
              }
            : message
        ),
      };
    });

    if (updates.localFileUri) {
      await offlineService.updateMessageLocalUri(messageId, updates.localFileUri);
    }
  }, [messages]);

  const addReaction = useCallback(async (chatId: string, messageId: string, emoji: string | null) => {
    setMessages((prev) => ({
      ...prev,
      [chatId]: (prev[chatId] || []).map((message) =>
        message.id === messageId
          ? {
              ...message,
              reactions: emoji ? [emoji] : [],
            }
          : message
      ),
    }));
    await offlineService.updateMessageReaction(messageId, emoji);
  }, []);

  const deleteMessage = useCallback(async (chatId: string, messageId: string) => {
    const current = messages[chatId]?.find(m => m.id === messageId);
    
    // Within 5 minutes and I am the sender -> DELETE FOR EVERYONE
    if (current && current.sender === 'me' && isWithinEditWindow(current.timestamp)) {
      console.log(`[ChatContext] Deleting for everyone: ${messageId}`);
      await chatService.requestDeleteForEveryone(messageId);
      // Fall through to local delete
    } else {
      console.log(`[ChatContext] Deleting for me only: ${messageId}`);
    }

    setMessages((prev) => ({
      ...prev,
      [chatId]: (prev[chatId] || []).filter((message) => message.id !== messageId),
    }));
    await offlineService.deleteMessage(messageId);
  }, [messages]);

  const toggleHeart = useCallback(async (chatId: string, messageId: string) => {
    const current = messages[chatId]?.find((message) => message.id === messageId);
    const nextEmoji = current?.reactions?.[0] === '❤️' ? null : '❤️';
    await addReaction(chatId, messageId, nextEmoji);
  }, [addReaction, messages]);

  const sendTyping = useCallback((isTyping: boolean) => {
    if (!currentUser || !otherUser) return;
    presenceChannelRef.current?.send({
      type: 'broadcast',
      event: isTyping ? 'typing' : 'stop-typing',
      payload: { userId: currentUser.id },
    });
  }, [currentUser, otherUser]);

  const clearChatMessages = useCallback(async (partnerId: string) => {
    await offlineService.clearChat(partnerId);
    setMessages((prev) => ({ ...prev, [partnerId]: [] }));
    setContacts((prev) =>
      prev.map((contact) =>
        contact.id === partnerId
          ? { ...contact, lastMessage: '', unreadCount: 0 }
          : contact
      )
    );
  }, []);

  const archiveContact = useCallback(async (partnerId: string, archive: boolean = true) => {
    await offlineService.setContactArchived(partnerId, archive);
    setContacts((prev) =>
      prev.map((contact) =>
        contact.id === partnerId
          ? { ...contact, isArchived: archive }
          : contact
      )
    );
  }, []);

  const unfriendContact = useCallback(async (partnerId: string) => {
    try {
      const response = await fetch(`${SERVER_URL}/api/connections/${partnerId}`, {
        method: 'DELETE',
        headers: { 'x-user-id': currentUser?.id || '' }
      });
      const data = await response.json() as any;
      if (data.success) {
        setContacts(prev => prev.filter(c => c.id !== partnerId));
        await clearChatMessages(partnerId);
      }
    } catch (err) {
      console.error('[ChatContext] unfriendContact error:', err);
    }
  }, [currentUser, clearChatMessages]);

  const fetchOtherUserProfile = useCallback(async (userId: string) => {
    const sid = (userId && LEGACY_TO_UUID[userId]) || userId;
    if (sid === LEGACY_TO_UUID['shri']) {
      setOtherUser({
        id: sid,
        name: 'Shri Ram',
        username: 'shri',
        avatar: 'https://avatar.iran.liara.run/public/boy?username=shri',
        bio: 'SoulSync Founder | Jai Shree Ram',
      });
      return;
    }
    if (sid === LEGACY_TO_UUID['hari']) {
      setOtherUser({
        id: sid,
        name: 'Hari Om',
        username: 'hari',
        avatar: 'https://avatar.iran.liara.run/public/boy?username=hari',
        bio: 'SoulSync Dev | Om Namah Shivay',
      });
      return;
    }
    try {
      const { data } = await supabase.from('profiles').select('*').eq('id', sid).single();
      if (data) {
        setOtherUser({
          id: data.id,
          name: data.display_name || data.name || data.username || 'User',
          username: data.username,
          avatar: proxySupabaseUrl(data.avatar_url),
          bio: data.bio || 'Forever in sync',
        });
      }
    } catch (error) {
      console.warn('[ChatContext] fetchOtherUserProfile failed:', error);
    }
  }, []);

  const contextValue = useMemo(() => ({
    contacts,
    messages,
    onlineUsers,
    typingUsers,
    otherUser,
    connectivity,
    setOtherUser,
    addMessage: sendChatMessage,
    sendChatMessage,
    updateMessage,
    addReaction,
    deleteMessage,
    toggleHeart,
    sendTyping,
    clearChatMessages,
    fetchOtherUserProfile,
    initializeChatSession,
    cleanupChatSession,
    refreshLocalCache: refreshContactsFromServer,
    uploadProgressTracker,
    archiveContact,
    unfriendContact,
  }), [
    contacts,
    messages,
    onlineUsers,
    typingUsers,
    otherUser,
    connectivity,
    setOtherUser,
    sendChatMessage,
    updateMessage,
    addReaction,
    deleteMessage,
    toggleHeart,
    sendTyping,
    clearChatMessages,
    fetchOtherUserProfile,
    initializeChatSession,
    cleanupChatSession,
    refreshContactsFromServer,
    archiveContact,
    unfriendContact,
  ]);

  return <ChatContext.Provider value={contextValue}>{children}</ChatContext.Provider>;
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};
