import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../config/supabase';
import { proxySupabaseUrl, SERVER_URL, safeFetchJson } from '../config/api';
import { chatService, type ChatMessage } from '../services/ChatService';
import { offlineService, type QueuedMessage } from '../services/LocalDBService';
import { useAuth } from './AuthContext';
import { type Contact, type Message } from '../types';

export const LEGACY_TO_UUID: Record<string, string> = {
  'shri': '4d28b137-66ff-4417-b451-b1a421e34b25',
  'hari': '02e52f08-6c1e-497f-93f6-b29c275b8ca4',
};

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
  return {
    id: row.id,
    name: row.name ?? 'Unknown',
    avatar: row.avatar ?? '',
    status: row.status ?? 'offline',
    lastMessage: row.lastMessage ?? row.last_message ?? '',
    unreadCount: row.unreadCount ?? row.unread_count ?? 0,
    about: row.about ?? row.bio ?? '',
    lastSeen: row.lastSeen ?? row.last_seen ?? undefined,
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
  const [connectivity, setConnectivity] = useState(chatService.getConnectivityState());
  const presenceChannelRef = useRef<any>(null);
  const activeChatIdRef = useRef<string | null>(null);

  const contactsRef = useRef<Contact[]>([]);

  const hydrateFromLocalDb = useCallback(async () => {
    try {
      const hydrationTimeout = 15000;
      await Promise.race([
        offlineService.initialize(),
        new Promise<void>((resolve) => setTimeout(() => {
          console.warn('[ChatContext] Offline DB init timed out (15s), moving on');
          resolve();
        }, hydrationTimeout))
      ]);

      // FIX: Migrate legacy IDs (shri, hari) to UUIDs so history is preserved
      await offlineService.migrateLegacyIds(LEGACY_TO_UUID);
    } catch (e) {
      console.warn('[ChatContext] Offline DB init failed:', e);
    }

    try {
      const dbQueryTimeout = 15000;

      // Phase 1: Contacts (INSTANT) - Fix for blank screen on refresh
      const localContacts = await Promise.race([
        offlineService.getContacts(),
        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), dbQueryTimeout))
      ]) as any[];

      if (localContacts && localContacts.length > 0) {
        const normalized = localContacts.map(normalizeContact);
        contactsRef.current = normalized;
        setContacts(normalized);
        console.log(`[ChatContext] Instant hydration: ${normalized.length} contacts`);
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
    await hydrateFromLocalDb();

    // Phase 2: Background network sync
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
              // Emergency fallback icon/name for superuser
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
          const normalized = allVisibleProfiles.map(normalizeContact);
          contactsRef.current = normalized;
          setContacts(normalized);
          
          // Background sync to persistent storage
          for (const profile of allVisibleProfiles) {
            const primaryId = LEGACY_TO_UUID[profile.id] || profile.id;
            const existing = contactsRef.current.find(c => c.id === primaryId);
            await offlineService.saveContact({
              id: primaryId,
              name: profile.display_name || profile.username || 'User',
              avatar: profile.avatar_url || existing?.avatar || '',
              avatarType: profile.avatar_type || existing?.avatarType || 'default',
              status: existing?.status || 'offline',
              lastMessage: existing?.lastMessage || '',
              unreadCount: existing?.unreadCount || 0
            });
          }
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
      await hydrateFromLocalDb();
      if (!cancelled) {
        await refreshContactsFromServer();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentUser, hydrateFromLocalDb, refreshContactsFromServer]);

  const upsertMessage = useCallback((partnerId: string, nextMessage: Message) => {
    setMessages((prev) => {
      const current = prev[partnerId] || [];
      const exists = current.find((item) => item.id === nextMessage.id);
      const updated = exists
        ? current.map((item) => (item.id === nextMessage.id ? { ...item, ...nextMessage } : item))
        : [...current, nextMessage];

      updated.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      return { ...prev, [partnerId]: updated };
    });
  }, []);

  const updateContactPreview = useCallback((partnerId: string, message: Message) => {
    const preview = message.text?.trim() || (message.media ? 'Media' : '');

    setContacts((prev) => {
      const existing = prev.find((contact) => contact.id === partnerId);
      if (!existing) {
        return prev;
      }

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

  const handleIncomingMessage = useCallback((message: ChatMessage) => {
    if (!currentUser) return;

    const partnerId =
      message.sender_id === currentUser.id ? message.receiver_id : message.sender_id;
    const normalized = mapChatMessage(message, currentUser.id);

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

  const initializeChatSession = useCallback(async (partnerId: string) => {
    if (!currentUser) return;

    activeChatIdRef.current = partnerId;
    await chatService.initialize(
      currentUser.id,
      partnerId,
      currentUser.name,
      handleIncomingMessage,
      handleStatusUpdate,
      () => setConnectivity(chatService.getConnectivityState()),
      (msgId, progress) => {
        setUploadProgressTracker(prev => ({ ...prev, [msgId]: progress }));
      }
    );
    setConnectivity(chatService.getConnectivityState());

    const existingMessages = await offlineService.getMessages(partnerId, 500);
    setMessages((prev) => ({
      ...prev,
      [partnerId]: existingMessages.map(mapQueuedMessage),
    }));
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
          if (presence.user_id) {
            users.add(presence.user_id);
          }
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

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
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
    
    setMessages((prev) => {
      const chatMsgs = prev[chatId];
      if (!chatMsgs) return prev;
      
      return {
        ...prev,
        [chatId]: chatMsgs.map((message) =>
          message.id === messageId ? { ...message, ...updates } : message
        ),
      };
    });

    if (updates.localFileUri) {
      await offlineService.updateMessageLocalUri(messageId, updates.localFileUri);
    }
  }, []);

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
    setMessages((prev) => ({
      ...prev,
      [chatId]: (prev[chatId] || []).filter((message) => message.id !== messageId),
    }));

    await offlineService.deleteMessage(messageId);
  }, []);

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

    setMessages((prev) => ({
      ...prev,
      [partnerId]: [],
    }));

    setContacts((prev) =>
      prev.map((contact) =>
        contact.id === partnerId
          ? { ...contact, lastMessage: '', unreadCount: 0 }
          : contact
      )
    );
  }, []);

  const fetchOtherUserProfile = useCallback(async (userId: string) => {
    // FIX: Standardize userId first to handle legacy/UUID consistently
    const sid = (userId && LEGACY_TO_UUID[userId]) || userId;

    // FIX: Support hardcoded bypass users (shri/hari)
    if (sid === LEGACY_TO_UUID['shri']) {
      setOtherUser({
        id: sid,
        name: 'Shri Ram',
        avatar: 'https://avatar.iran.liara.run/public/boy?username=shri',
        bio: 'SoulSync Founder | Jai Shree Ram',
      });
      return;
    }
    if (sid === LEGACY_TO_UUID['hari']) {
      setOtherUser({
        id: sid,
        name: 'Hari Om',
        avatar: 'https://avatar.iran.liara.run/public/boy?username=hari',
        bio: 'SoulSync Dev | Om Namah Shivay',
      });
      return;
    }

    try {
      // Use the mapped UUID (sid) instead of raw userId
      const queryId = sid;
      const { data } = await supabase.from('profiles').select('*').eq('id', queryId).single();
      if (data) {
        setOtherUser({
          id: data.id,
          name: data.display_name || data.name || 'User',
          avatar: proxySupabaseUrl(data.avatar_url),
          bio: data.bio || 'Forever in sync',
        });
      }
    } catch (error) {
      console.warn('[ChatContext] fetchOtherUserProfile failed:', error);
    }
  }, []);

  const value = useMemo<ChatContextType>(() => ({
    contacts,
    messages,
    onlineUsers,
    typingUsers,
    uploadProgressTracker,
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
  }), [
    contacts,
    messages,
    onlineUsers,
    typingUsers,
    uploadProgressTracker,
    otherUser,
    connectivity,
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
  ]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};
