import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../config/supabase';
import { proxySupabaseUrl, SERVER_URL, safeFetchJson } from '../config/api';
import { chatService, type ChatMessage } from '../services/ChatService';
import { offlineService, type QueuedMessage } from '../services/LocalDBService';
import { soulFolderService } from '../services/SoulFolderService';
import { downloadQueue } from '../services/DownloadQueueService';
import { useAuth } from './AuthContext';
import { type Contact, type Message } from '../types';
import { mergeGroupedMediaThumbnail } from '../utils/chatUtils';

import { normalizeId, getSuperuserName, LEGACY_TO_UUID, isWithinEditWindow } from '../utils/idNormalization';
import { Alert, AppState } from 'react-native';
import { syncAvatar } from '../services/MediaDownloadService';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── INTERNAL BLACKLIST ────────────────────────────────────────────────────────
// These are test/internal accounts that should never appear in the UI.
const INTERNAL_BLACKLIST = [
  'bef2332f-4d4c-4303-bba7-a413a3b6b234', // Test Temp
  '7bf14625-5b4b-42fa-b5eb-88218c5754b7', // hari.internal@soul.dev
];

const isBlacklisted = (id: string, name?: string) => {
  const normalizedId = LEGACY_TO_UUID[id] || id;
  if (INTERNAL_BLACKLIST.includes(normalizedId)) return true;
  if (name?.toLowerCase().includes('.internal@soul.dev')) return true;
  return false;
};

const GLOBAL_INBOX_FALLBACK_POLL_MS = 2000;
const GLOBAL_INBOX_HEALTHY_POLL_MS = 15000;
const GLOBAL_INBOX_LOOKBACK_MS = 10 * 60 * 1000;
const GLOBAL_INBOX_MAX_ROWS = 100;

const MESSAGE_STATUS_RANK: Record<string, number> = {
  pending: 0,
  failed: 0,
  sent: 1,
  delivered: 2,
  read: 3,
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
  deleteMessage: (chatId: string, messageId: string, isAdmin?: boolean, deleteForMeOnly?: boolean) => Promise<void>;
  toggleHeart: (chatId: string, messageId: string) => Promise<void>;
  sendMediaLikePulse: (toUserId: string, messageId: string, mediaIndex: number) => void;
  remoteLikePulse: { messageId: string; mediaIndex: number; nonce: number } | null;
  sendTyping: (isTyping: boolean) => void;
  clearChatMessages: (partnerId: string) => Promise<void>;
  fetchOtherUserProfile: (userId: string) => Promise<void>;
  initializeChatSession: (partnerId: string, isGroup?: boolean) => Promise<void>;
  cleanupChatSession: (partnerId?: string) => void;
  refreshLocalCache: (force?: boolean) => Promise<void>;
  uploadProgressTracker: Record<string, number>;
  archiveContact: (partnerId: string, archive?: boolean) => Promise<void>;
  unfriendContact: (partnerId: string) => Promise<void>;
  offlineService: any;
}

export const ChatContext = createContext<ChatContextType | undefined>(undefined);

function mapQueuedMessage(row: QueuedMessage): Message {
  return {
    id: row.id,
    sender: row.sender,
    senderName: row.senderName,
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
  const normalizedMedia = message.media
    ? {
        ...message.media,
        // theater_session media.url is a YouTube videoId, not an R2/Supabase
        // storage key — keep it as-is so the player can find the right video.
        url: message.media.type === 'theater_session'
          ? message.media.url
          : proxySupabaseUrl(message.media.url),
      }
    : undefined;

  return {
    id: message.id,
    sender: message.sender_id === currentUserId ? 'me' : 'them',
    senderId: message.sender_id,
    text: message.text ?? '',
    timestamp: message.timestamp,
    status: message.status,
    reactions: message.reactions,
    replyTo: message.reply_to,
    media: normalizedMedia,
    senderName: message.senderName,
    localFileUri: message.localFileUri,
  };
}

function mapServerRowToChatMessage(row: any): ChatMessage {
  const isTheater = row.media_type === 'theater_session';
  let rawUrl = row.media_url ?? '';
  // Heal videoIds that an older proxySupabaseUrl build prefixed with the R2
  // public base when they round-tripped through the queue. Without this both
  // sides land on different Supabase presence channels for the same session.
  if (isTheater && /^https:\/\/pub-[a-f0-9]+\.r2\.dev\/[A-Za-z0-9_-]{6,15}$/.test(rawUrl)) {
    rawUrl = rawUrl.split('/').pop() || rawUrl;
  }
  const media = (row.media_url || row.media_type || row.media_thumbnail)
    ? {
        type: row.media_type ?? 'image',
        url: isTheater ? rawUrl : proxySupabaseUrl(rawUrl),
        caption: row.media_caption ?? undefined,
        thumbnail: row.media_thumbnail ?? undefined,
        duration: row.media_duration ?? undefined,
      }
    : undefined;

  if (media && media.type === 'theater_session') {
    const { hydrateTheaterMediaFromCaption } = require('../utils/theaterMetaCodec');
    hydrateTheaterMediaFromCaption(media);
  }

  return {
    id: row.id?.toString?.() ?? String(row.id),
    sender_id: row.sender,
    receiver_id: row.receiver,
    group_id: row.group_id ?? undefined,
    text: row.text ?? '',
    timestamp: row.created_at ?? row.timestamp ?? new Date().toISOString(),
    status: row.status ?? 'sent',
    media,
    reply_to: row.reply_to_id ? row.reply_to_id.toString() : undefined,
    senderName: row.sender_name ?? undefined,
    reactions: row.reaction ? [row.reaction] : undefined,
  };
}

function mergeMessageStatus(existing?: Message['status'], next?: Message['status']): Message['status'] | undefined {
  if (!existing) return next;
  if (!next) return existing;
  if (existing === 'failed' && next !== 'pending' && next !== 'failed') return next;
  if (next === 'failed') return existing === 'pending' ? 'failed' : existing;
  return (MESSAGE_STATUS_RANK[next] ?? 0) >= (MESSAGE_STATUS_RANK[existing] ?? 0)
    ? next
    : existing;
}

function mergeMessageMedia(
  existingMedia?: Message['media'],
  nextMedia?: Message['media']
): Message['media'] | undefined {
  if (!existingMedia) return nextMedia;
  if (!nextMedia) return existingMedia;

  return {
    ...existingMedia,
    ...nextMedia,
    url: nextMedia.url || existingMedia.url,
    thumbnail: mergeGroupedMediaThumbnail(existingMedia.thumbnail, nextMedia.thumbnail),
  };
}

function normalizeContact(row: any): Contact {
  if (!row) {
    return {
      id: '',
      name: 'User',
      avatar: '',
      status: 'offline',
      lastMessage: '',
      unreadCount: 0,
      about: '',
      avatarType: 'default',
      lastSeen: undefined,
    };
  }
  const superuserName = getSuperuserName(row.id);
  const name = superuserName || row.displayName || row.display_name || row.full_name || row.name || row.username || (row.id ? `@${row.id.substring(0, 5)}` : 'User');
  return {
    id: row.id || '',
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
    isGroup: row.isGroup ?? row.is_group ?? false,
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
  // Per-chat realtime channel for typing + media-likes. Splitting these off
  // `presence-global` (which carries presence for ALL users) keeps each chat's
  // ephemeral broadcasts on a small, stable channel — fewer subscribers, fewer
  // CHANNEL_ERROR reconnect loops, less typing-event loss.
  const chatChannelRef = useRef<any>(null);
  const chatChannelKeyRef = useRef<string | null>(null);
  const globalMessageChannelRef = useRef<any>(null);
  const globalMessagePollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const globalMessageAppStateRef = useRef<{ remove: () => void } | null>(null);
  const globalMessageUserIdRef = useRef<string | null>(null);
  const globalMessageCursorRef = useRef<string | null>(null);
  const globalMessagePollInFlightRef = useRef(false);
  const globalRealtimeHealthyRef = useRef(false);
  const activeChatIdRef = useRef<string | null>(null);
  const lastServerSyncRef = useRef<number>(0);

  const [remoteLikePulse, setRemoteLikePulse] = useState<{
    messageId: string;
    mediaIndex: number;
    nonce: number;
  } | null>(null);

  const contactsRef = useRef<Contact[]>([]);
  const messagesRef = useRef<Record<string, Message[]>>({});
  const isHydratedRef = useRef(false);
  const isHydratingRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const hydrateFromLocalDb = useCallback(async (passedUserId?: string, force = false) => {
    if (!force && (isHydratedRef.current || isHydratingRef.current)) {
        return;
    }
    isHydratingRef.current = true;
    try {
      const dbStart = Date.now();
      let isInitDone = false;
      
      // Phase 1: DB Initialization (Blocking, but with more generous timeout)
      await Promise.race([
        offlineService.initialize().then(() => { isInitDone = true; }),
        new Promise<void>((resolve) => setTimeout(() => {
          if (!isInitDone) {
            console.warn(`[ChatContext] SQLite init timed out after ${Date.now() - dbStart}ms (continuing anyway)`);
          }
          resolve();
        }, 12000))
      ]);
      
      // ... rest of the existing logic ...

      // Phase 2: Folders & Queue (Background - don't block contact display)
      soulFolderService.init().catch(e => console.warn('[ChatContext] Folder init error:', e));
      downloadQueue.init().catch(e => console.warn('[ChatContext] Queue init error:', e));

      // FIX: Migrate legacy IDs (shri, hari) to UUIDs so history is preserved
      await offlineService.migrateLegacyIds(LEGACY_TO_UUID);

      // Backfill any historical drift between `groups` and `contacts` so that
      // every group row carries is_group=1 and an avatar — even on installs
      // that pre-date the sticky-flag SQL fix. Runs every startup; idempotent.
      await offlineService.reconcileGroupsToContacts?.();

      // Perform one-time migration of old media files if needed (in background)
      soulFolderService.migrateFromOldCache().catch(() => {});
      soulFolderService.migrateOldStorageServiceFiles().catch(() => {});
      
    } catch (e) {
      console.warn('[ChatContext] Offline init failed:', e);
    }

    try {
      const dbQueryTimeout = 30000;

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
            if (isBlacklisted(c.id, c.name)) {
                console.log('[ChatContext] Purging blacklisted contact from local DB:', c.id);
                offlineService.deleteContact(c.id).catch(() => {});
                return false;
            }

            // --- NUCLEAR PURGE: Delete any placeholder users with 0 messages ---
            const placeholderNames = ['User', 'Check', 'Discovery'];
            if (placeholderNames.includes(c.name) || !c.name) {
               // We don't have messagesRef yet here, but we can check SQLite directly
               // OR just hide them for now and let the sync-pruning handle the DB delete.
               // For instant fix: hide them if they have no last message text
               if (!c.lastMessage || c.lastMessage === 'Start a conversation') {
                  console.log('[ChatContext] Hiding/Purging placeholder:', c.name);
                  offlineService.deleteContact(c.id).catch(() => {});
                  return false;
               }
            }

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
        console.log(`[ChatContext] Instant hydration: ${normalized.length} contacts (filtered blacklisted/self)`);
      }

      // Phase 2: Messages (PREVIEW ONLY) - Load only latest per chat to populate list
      const localMessages = await Promise.race([
        offlineService.getLatestMessagesSummary(1),
        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), dbQueryTimeout))
      ]) as any[];

      // If timeout fired and returned empty, don't overwrite existing messages in state
      if (!localMessages || localMessages.length === 0) {
        console.warn('[ChatContext] No local messages returned for summary, using existing state');
        // If we have some messages but no summary, it might be a weird state, but continuing is safer
      }

      const grouped = (localMessages).reduce((acc: Record<string, Message[]>, row: any) => {
        const normalizedChatId = LEGACY_TO_UUID[row.chatId] || row.chatId;
        if (!acc[normalizedChatId]) acc[normalizedChatId] = [];
        acc[normalizedChatId].push(row); // Use raw message for hydration, it will be mapped/sorted when needed
        return acc;
      }, {});

      // Mapping QueuedMessages to display Messages
      const mappedGrouped: Record<string, Message[]> = {};
      Object.keys(grouped).forEach(chatId => {
        mappedGrouped[chatId] = (grouped[chatId] as any[]).map(mapQueuedMessage);
      });

      setMessages(mappedGrouped);
      isHydratedRef.current = true;
      console.log(`[ChatContext] Local hydration complete. Loaded ${Object.keys(mappedGrouped).length} chat previews.`);
    } catch (e) {
      console.warn('[ChatContext] hydrateFromLocalDb error:', e);
    } finally {
      isHydratingRef.current = false;
    }
  }, []);

  const refreshContactsFromServer = useCallback(async (force = false) => {
    if (!currentUser) return;

    const myUuid = LEGACY_TO_UUID[currentUser.id] || currentUser.id;
    const superUserIds = [LEGACY_TO_UUID['shri'], LEGACY_TO_UUID['hari']];
    const isSelfSuperUser = superUserIds.includes(myUuid) || 
                           currentUser.username === 'hari' || 
                           currentUser.username === 'shri' ||
                           currentUser.id?.startsWith('f00f00f0');

    // Phase 1: Instant local load (force = true so newly added local rows
    // such as a just-created group surface immediately).
    await hydrateFromLocalDb(currentUser.id, force);

    // Group sync runs on EVERY refresh (not behind the 5-min profile throttle).
    // Without this, a quick reload throttles us out before group avatars
    // ever reach SQLite — so the chat list keeps showing the placeholder
    // for any group whose photo lives only in remote chat_groups.
    //
    // Local-first like WhatsApp: the avatar bytes get downloaded once into
    // Soul/Media/Soul Profile Photos/ and the file path is stored in
    // contacts.local_avatar_uri. Subsequent renders read straight from disk
    // — no proxy, no network — and we only re-download when chat_groups
    // updated_at changes (syncAvatar handles that comparison).
    // Fire-and-forget so we don't block the profile path.
    (async () => {
      try {
        const { data: memberships, error: membershipErr } = await supabase
          .from('chat_group_members')
          .select('group_id')
          .eq('user_id', myUuid);
        // Only prune when we have a clean response from the server (not a
        // network error / RLS denial), otherwise an offline launch could
        // wipe valid local groups.
        if (!membershipErr) {
          const remoteGroupIds = new Set((memberships || []).map((m: any) => m.group_id).filter(Boolean));
          try {
            const localContacts = await offlineService.getContacts();
            const staleGroupIds = localContacts
              .filter((c: any) => c.isGroup && !remoteGroupIds.has(c.id))
              .map((c: any) => c.id);
            for (const sid of staleGroupIds) {
              try { await offlineService.deleteGroup?.(sid); } catch {}
            }
            if (staleGroupIds.length > 0) {
              setContacts(prev => prev.filter(c => !staleGroupIds.includes(c.id)));
              const refSet = new Set(staleGroupIds);
              contactsRef.current = contactsRef.current.filter(c => !refSet.has(c.id));
            }
          } catch (pruneErr) {
            console.warn('[ChatContext] Stale group prune failed:', pruneErr);
          }
        }
        const groupIds = (memberships || []).map((m: any) => m.group_id).filter(Boolean);
        if (groupIds.length === 0) return;
        const { data: groupRows } = await supabase
          .from('chat_groups')
          .select('id, name, description, avatar_url, updated_at')
          .in('id', groupIds);
        if (!groupRows || groupRows.length === 0) return;
        for (const g of groupRows) {
          try {
            await offlineService.saveGroup({
              id: g.id,
              name: g.name || 'Group',
              description: g.description ?? undefined,
              avatarUrl: g.avatar_url ?? undefined,
              updatedAt: g.updated_at ?? new Date().toISOString(),
            } as any);
          } catch (gErr) {
            console.warn('[ChatContext] saveGroup during sync failed for', g.id, gErr);
          }
        }
        setContacts(prev => {
          const merged = [...prev];
          for (const g of groupRows) {
            const idx = merged.findIndex(c => c.id === g.id);
            const next: any = {
              id: g.id,
              name: g.name || 'Group',
              avatar: g.avatar_url || (idx !== -1 ? merged[idx].avatar : '') || '',
              avatarType: 'default',
              status: 'offline',
              lastMessage: idx !== -1 ? merged[idx].lastMessage : '',
              unreadCount: idx !== -1 ? merged[idx].unreadCount : 0,
              about: g.description ?? (idx !== -1 ? merged[idx].about : ''),
              isGroup: true,
              localAvatarUri: idx !== -1 ? merged[idx].localAvatarUri : undefined,
            };
            if (idx !== -1) merged[idx] = { ...merged[idx], ...next };
            else merged.push(next);
          }
          contactsRef.current = merged;
          return merged;
        });

        // Download each group avatar to the Soul folder (skips work when
        // already cached at the same updated_at). Once on disk, the chat
        // list reads from the file path directly — no network on subsequent
        // app opens, just like WhatsApp.
        for (const g of groupRows) {
          if (!g.avatar_url) continue;
          syncAvatar(g.id, g.avatar_url, g.updated_at).then(localUri => {
            if (!localUri) return;
            setContacts(prev => prev.map(c =>
              c.id === g.id ? { ...c, localAvatarUri: localUri } : c
            ));
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('[ChatContext] Group sync error:', e);
      }
    })();

    // Phase 2: Background network sync with 5-minute throttling
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;

    // Read from AsyncStorage if ref is 0 (first run since app start)
    if (lastServerSyncRef.current === 0) {
      const saved = await AsyncStorage.getItem('ss_last_contact_sync');
      if (saved) lastServerSyncRef.current = parseInt(saved, 10);
    }

    if (!force && !isSelfSuperUser && now - lastServerSyncRef.current < FIVE_MINUTES) {
      console.log('[ChatContext] Skipping server refresh (synced recently)');
      return;
    }

    (async () => {
      try {
        let allVisibleProfiles: any[] = [];
        let serverSuccess = false;

        // 1. Try server API
        try {
          // If the server URL is the proxy or a direct Supabase host, skip the business-logic API call
          // and go straight to the Supabase tables fallback (Point 2)
          if (SERVER_URL.includes('workers.dev') || SERVER_URL.includes('supabase.co')) {
             console.log('[ChatContext] SERVER_URL is a proxy/supabase, using Supabase direct for connections');
          } else {
            const { success, data } = await safeFetchJson<any>(`${SERVER_URL}/api/connections`, {
              headers: { 'x-user-id': currentUser.id }
            });
            if (success && data?.success) {
              allVisibleProfiles = data.connections || [];
              serverSuccess = true;
            }
          }
        } catch {
          console.warn('[ChatContext] Server refresh failed, falling back to direct Supabase query');
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

        // 3. Superuser pairing: when the logged-in user IS a superuser
        // (Hari or Shri), force the *other* superuser into the visible
        // contacts list so the two are always reachable from each other.
        // We deliberately do NOT fetch all profiles here — that admin-style
        // discovery was a separate experiment and is intentionally left off.
        if (isSelfSuperUser) {
          const otherSuperUserId = superUserIds.find(id => id !== myUuid);
          if (otherSuperUserId && !allVisibleProfiles.some(p => p.id === otherSuperUserId)) {
            try {
              const { data: otherProfile } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', otherSuperUserId)
                .maybeSingle();
              if (otherProfile) {
                allVisibleProfiles.push(otherProfile);
              } else {
                // Profile row missing on server — synthesize a minimal
                // entry so the contact still renders. AuthService also
                // upserts the superuser record on first login, so this
                // fallback is just for a cold device that hasn't met the
                // counterpart yet.
                allVisibleProfiles.push({
                  id: otherSuperUserId,
                  username: otherSuperUserId === LEGACY_TO_UUID['shri'] ? 'shri' : 'hari',
                  display_name: otherSuperUserId === LEGACY_TO_UUID['shri'] ? 'Shri' : 'Hari',
                  avatar_type: 'teddy',
                  teddy_variant: otherSuperUserId === LEGACY_TO_UUID['shri'] ? 'girl' : 'boy',
                });
              }
            } catch (err) {
              console.warn('[ChatContext] Superuser pairing fetch failed:', err);
            }
          }
        }

        if (allVisibleProfiles.length > 0) {
          const normalized = allVisibleProfiles
            .filter(p => {
              if (!p) return false;
              const pId = LEGACY_TO_UUID[p.id] || p.id;
              return pId !== myUuid;
            })
            .map(p => {
              const n = normalizeContact(p);
              // PRESERVE local state from the already-hydrated contacts
              const existing = contactsRef.current.find(c => c.id === n.id);
              if (existing) {
                return {
                  ...existing,
                  ...n,
                  localAvatarUri: n.localAvatarUri || existing.localAvatarUri,
                  avatarUpdatedAt: n.avatarUpdatedAt || existing.avatarUpdatedAt,
                };
              }
              return n;
            });

          contactsRef.current = normalized;
          setContacts(prev => {
            // MERGE: Keep existing ones that aren't in the server response 
            const merged = [...prev];
            normalized.forEach(n => {
              if (isBlacklisted(n.id, n.name)) {
                offlineService.deleteContact(n.id).catch(() => {});
                return;
              }
              const idx = merged.findIndex(c => c.id === n.id);
              if (idx !== -1) {
                merged[idx] = { ...merged[idx], ...n };
              } else {
                merged.push(n);
              }
            });
            
            // Final safety filter
            return merged.filter(c => !isBlacklisted(c.id, c.name));
          });

          const batchToSave: any[] = [];
          for (const profile of allVisibleProfiles) {
            const primaryId = LEGACY_TO_UUID[profile.id] || profile.id;
            if (primaryId === myUuid) continue; 
            
            const existing = contactsRef.current.find(c => c.id === primaryId);
            const avatarUrl = profile.avatar_url || existing?.avatar || '';
            const updatedAt = profile.updated_at || existing?.last_updated_at || new Date().toISOString();

            // Background sync the avatar file (still individual, but non-blocking)
            if (avatarUrl) {
              syncAvatar(primaryId, avatarUrl, updatedAt).then(localUri => {
                if (localUri) {
                  setContacts(prev => prev.map(c => 
                    c.id === primaryId ? { ...c, localAvatarUri: localUri } : c
                  ));
                }
              }).catch(() => {});
            }

            batchToSave.push({
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

          if (batchToSave.length > 0) {
            await offlineService.saveContactsBatch(batchToSave);
            console.log(`[ChatContext] Batched save for ${batchToSave.length} contacts complete.`);
          }

          // --- ROBUST PRUNING ---
          // Always prune stale discovery contacts after a server sync attempt
          const remoteIds = new Set(batchToSave.map(c => c.id));
          const currentContacts = [...contactsRef.current];
          const staleContacts = currentContacts.filter(c => !c.isGroup && !remoteIds.has(c.id));

          if (staleContacts.length > 0) {
            console.log(`[ChatContext] Found ${staleContacts.length} potentially stale contacts to prune`);
            for (const stale of staleContacts) {
              const msgs = messagesRef.current[stale.id] || [];
              if (msgs.length === 0) {
                console.log(`[ChatContext] Pruning stale discovery contact: ${stale.id} (${stale.name})`);
                await offlineService.deleteContact(stale.id).catch(() => {});
                setContacts(prev => prev.filter(c => c.id !== stale.id));
                contactsRef.current = contactsRef.current.filter(c => c.id !== stale.id);
              }
            }
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
      lastServerSyncRef.current = 0; // Reset sync throttle for next user
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
          status: mergeMessageStatus(existing.status, nextMessage.status),
          media: mergeMessageMedia(existing.media, nextMessage.media),
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

    const partnerId = message.group_id || (message.sender_id === currentUser.id ? message.receiver_id : message.sender_id);
    const normalized = mapChatMessage(message, currentUser.id);

    // Populate sender name for group messages
    if (message.group_id && normalized.sender === 'them') {
      // Priority 1: Name from the message itself (added in latest synchronization)
      // Priority 2: Name from our local contacts cache
      const senderFromMessage = message.senderName;
      const senderFromContacts = contactsRef.current.find(c => c.id === message.sender_id)?.name;
      normalized.senderName = senderFromMessage || senderFromContacts || 'Someone';
    }

    const alreadyExists = (messagesRef.current[partnerId] || []).some((item) => item.id === normalized.id);

    // FIX Root Cause: Before updating state, check if we already have a localFileUri (or thumbnail JSON) in SQLite
    if (normalized.media) {
      const stored = await offlineService.getMessageById(normalized.id);
      if (stored && stored.media) {
        // Restore top-level local path
        if (stored.localFileUri && !normalized.localFileUri) {
          normalized.localFileUri = stored.localFileUri;
        }
        // Restore/Merge Grouped Media metadata (paths inside thumbnail JSON)
        if (stored.media.thumbnail && stored.media.thumbnail.startsWith('__MEDIA_GROUP_V1__:')) {
          normalized.media.thumbnail = mergeGroupedMediaThumbnail(stored.media.thumbnail, normalized.media.thumbnail);
        }
      }
    }

    upsertMessage(partnerId, normalized);
    if (!alreadyExists) {
      updateContactPreview(partnerId, normalized);
    }

    // WhatsApp-style: pre-fetch media in background when message arrives.
    // Skip theater_session — its `media.url` is a YouTube videoId, not an R2
    // storage key, and the prefetch would treat it as an R2 download (which
    // 404s and triggers a spurious server-side delete request).
    if (
      normalized.media?.url &&
      !normalized.localFileUri &&
      normalized.media.type !== 'theater_session'
    ) {
      const mediaUrl = normalized.media.url;
      if (!mediaUrl.startsWith('file:') && !mediaUrl.startsWith('data:')) {
        downloadQueue.enqueue(normalized.id, mediaUrl, normalized.media.type, false, 2, false)
          .then((result) => {
            if (result.success && result.localUri) {
              // Update state so UI picks up the local file
              upsertMessage(partnerId, { ...normalized, localFileUri: result.localUri });
            }
          })
          .catch(() => {}); // Non-blocking background download
      }
    }
  }, [currentUser, updateContactPreview, upsertMessage]);

  const isServerMessageRowRelevant = useCallback((row: any) => {
    if (!currentUser || !row) return false;
    const myId = normalizeId(currentUser.id);
    const senderId = row.sender ? normalizeId(row.sender) : '';
    const receiverId = row.receiver ? normalizeId(row.receiver) : '';
    if (senderId === myId || receiverId === myId) return true;

    const groupId = row.group_id ? String(row.group_id) : '';
    if (!groupId) return false;
    return contactsRef.current.some((contact) => contact.isGroup && contact.id === groupId);
  }, [currentUser]);

  const advanceGlobalMessageCursor = useCallback((row: any) => {
    const timestamp = row?.created_at ?? row?.timestamp;
    if (!timestamp) return;
    const current = globalMessageCursorRef.current;
    if (!current || new Date(timestamp).getTime() > new Date(current).getTime()) {
      globalMessageCursorRef.current = timestamp;
    }
  }, []);

  const handleServerMessageRow = useCallback(async (row: any) => {
    if (!currentUser || !isServerMessageRowRelevant(row)) return;

    const message = mapServerRowToChatMessage(row);
    const myId = normalizeId(currentUser.id);
    const isMine = normalizeId(message.sender_id) === myId;
    const chatId = message.group_id || (isMine ? message.receiver_id : message.sender_id);
    if (!chatId) return;

    await offlineService.saveMessage(chatId, {
      id: message.id,
      sender: isMine ? 'me' : 'them',
      text: message.text,
      timestamp: message.timestamp,
      status: message.status,
      media: message.media,
      replyTo: message.reply_to,
      senderName: message.senderName,
      groupId: message.group_id,
    });

    await handleIncomingMessage(message);
    advanceGlobalMessageCursor(row);

    const isIncomingDirect = !isMine && normalizeId(message.receiver_id) === myId;
    const isIncomingGroup = !!message.group_id && !isMine;
    if ((isIncomingDirect || isIncomingGroup) && message.status !== 'delivered' && message.status !== 'read') {
      chatService.updateMessageStatusOnServer(message.id, 'delivered');
    }
  }, [advanceGlobalMessageCursor, currentUser, handleIncomingMessage, isServerMessageRowRelevant]);

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

  // Build a deterministic channel name for the chat. 1-on-1 sorts the two
  // user IDs so both peers compute the same name regardless of who opens the
  // chat first. Groups use the group's UUID.
  const buildChatChannelName = useCallback((partnerId: string, isGroup: boolean): string | null => {
    if (!currentUser?.id || !partnerId) return null;
    if (isGroup) return `chat:group:${partnerId}`;
    const a = normalizeId(currentUser.id);
    const b = normalizeId(partnerId);
    const [first, second] = [a, b].sort();
    return `chat:${first}_${second}`;
  }, [currentUser]);

  // Tear down the per-chat broadcast channel (typing, media-like). Safe to
  // call even if no channel is active.
  const teardownChatChannel = useCallback(() => {
    const ch = chatChannelRef.current;
    chatChannelRef.current = null;
    chatChannelKeyRef.current = null;
    if (ch) {
      try {
        ch.unsubscribe();
        supabase.removeChannel(ch);
      } catch (err) {
        console.warn('[ChatChannel] Teardown failed:', err);
      }
    }
  }, []);

  // Subscribe to the per-chat broadcast channel for typing + media-like
  // events. Replaces the equivalent listeners that used to live on
  // `presence-global` — keeps that global channel light (presence only).
  const subscribeChatChannel = useCallback((channelName: string) => {
    if (!currentUser) return;
    if (chatChannelKeyRef.current === channelName && chatChannelRef.current) {
      return; // already subscribed to the right channel
    }
    teardownChatChannel();

    const channel = supabase.channel(channelName, {
      config: { broadcast: { self: false } },
    });
    chatChannelRef.current = channel;
    chatChannelKeyRef.current = channelName;

    channel.on('broadcast', { event: 'typing' }, ({ payload }) => {
      console.log('[Typing] received typing from', payload?.userId);
      if (payload?.userId && payload.userId !== currentUser.id) {
        const normalizedId = normalizeId(payload.userId);
        setTypingUsers((prev) => Array.from(new Set([...prev, normalizedId])));
      }
    });

    channel.on('broadcast', { event: 'stop-typing' }, ({ payload }) => {
      console.log('[Typing] received stop-typing from', payload?.userId);
      if (payload?.userId) {
        const normalizedId = normalizeId(payload.userId);
        setTypingUsers((prev) => prev.filter((id) => id !== normalizedId));
      }
    });

    channel.on('broadcast', { event: 'media-like' }, ({ payload }) => {
      if (!payload) return;
      if (payload.toUserId !== currentUser.id) return;
      if (payload.fromUserId === currentUser.id) return;
      setRemoteLikePulse({
        messageId: String(payload.messageId),
        mediaIndex: Number.isFinite(payload.mediaIndex) ? payload.mediaIndex : 0,
        nonce: Date.now() + Math.random(),
      });
    });

    channel.on('broadcast', { event: 'theater-ended' }, ({ payload }) => {
      // The host sends this when ending a theater session. Update the local
      // message so the card flips from LIVE+Join → ENDED immediately, even
      // before the next full DB sync pulls the updated media_caption.
      if (!payload?.messageId || !payload?.chatId) return;
      console.log(`[ChatChannel] theater-ended for message ${payload.messageId}`);
      setMessages((prev) => {
        // Search across all loaded chats since payload.chatId is relative to the sender
        // and might not match the local key for this chat (e.g. guest uses hostId as key).
        let targetChatId: string | null = null;
        let hasMessage = false;

        for (const [chatKey, msgs] of Object.entries(prev)) {
          if (msgs.some((m) => m.id === payload.messageId)) {
            targetChatId = chatKey;
            hasMessage = true;
            break;
          }
        }

        if (!hasMessage || !targetChatId) return prev;

        return {
          ...prev,
          [targetChatId]: prev[targetChatId].map((m) => {
            if (m.id !== payload.messageId) return m;
            return {
              ...m,
              media: {
                ...m.media,
                theater: { ...(m.media?.theater || {}), status: 'ended', viewerCount: 0, participants: [] },
                caption: payload.caption || m.media?.caption,
              },
            };
          }),
        };
      });
    });

    channel.subscribe((status) => {
      console.log(`[ChatChannel] ${channelName} status:`, status);
    });
  }, [currentUser, teardownChatChannel]);

  const initializeChatSession = useCallback(async (partnerId: string, isGroup: boolean = false) => {
    if (!currentUser) return;
    activeChatIdRef.current = partnerId;

    // Load from SQLite first for instant responsiveness
    const existingMessages = await offlineService.getMessages(partnerId, 500);
    setMessages((prev) => ({
      ...prev,
      [partnerId]: existingMessages.map(mapQueuedMessage),
    }));

    // Detect if partnerId is a group ID from contacts
    const contact = contactsRef.current.find(c => c.id === partnerId);
    const finalIsGroup = isGroup || contact?.isGroup || false;

    // Start network session (syncs with Supabase)
    await chatService.initialize(
      currentUser.id,
      partnerId,
      currentUser.name,
      finalIsGroup,
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

    // Subscribe to the per-chat broadcast channel for typing + media-likes.
    const channelName = buildChatChannelName(partnerId, finalIsGroup);
    if (channelName) {
      subscribeChatChannel(channelName);
    }
  }, [currentUser, handleIncomingMessage, handleStatusUpdate, handleRemoteDelete, buildChatChannelName, subscribeChatChannel]);

  const cleanupChatSession = useCallback((partnerId?: string) => {
    if (!partnerId || activeChatIdRef.current === partnerId) {
      activeChatIdRef.current = null;
      chatService.cleanup();
      setConnectivity(chatService.getConnectivityState());
      teardownChatChannel();
      // Clear typingUsers so we don't carry a stale typing indicator into the
      // next chat the user opens.
      setTypingUsers([]);
    }
  }, [teardownChatChannel]);

  useEffect(() => {
    if (!currentUser) {
      if (globalMessagePollTimerRef.current) {
        clearInterval(globalMessagePollTimerRef.current);
        globalMessagePollTimerRef.current = null;
      }
      if (globalMessageAppStateRef.current) {
        globalMessageAppStateRef.current.remove();
        globalMessageAppStateRef.current = null;
      }
      if (globalMessageChannelRef.current) {
        supabase.removeChannel(globalMessageChannelRef.current);
        globalMessageChannelRef.current = null;
      }
      globalMessageCursorRef.current = null;
      globalMessageUserIdRef.current = null;
      globalRealtimeHealthyRef.current = false;
      return;
    }

    let cancelled = false;
    const myId = normalizeId(currentUser.id);
    if (globalMessageUserIdRef.current !== myId) {
      globalMessageCursorRef.current = null;
      globalMessageUserIdRef.current = myId;
    }

    const ensureCursor = async () => {
      if (globalMessageCursorRef.current) return;
      const latestLocal = await offlineService.getLatestGlobalMessageTimestamp?.();
      globalMessageCursorRef.current =
        latestLocal || new Date(Date.now() - GLOBAL_INBOX_LOOKBACK_MS).toISOString();
    };

    const pollGlobalInbox = async () => {
      if (cancelled || AppState.currentState !== 'active' || globalMessagePollInFlightRef.current) return;
      globalMessagePollInFlightRef.current = true;

      try {
        await ensureCursor();
        const cursor = globalMessageCursorRef.current || new Date(Date.now() - GLOBAL_INBOX_LOOKBACK_MS).toISOString();
        const groupIds = contactsRef.current
          .filter((contact) => contact.isGroup)
          .map((contact) => contact.id)
          .filter(Boolean)
          .slice(0, 50);
        const filters = [`sender.eq.${myId}`, `receiver.eq.${myId}`];
        if (groupIds.length > 0) {
          filters.push(`group_id.in.(${groupIds.join(',')})`);
        }

        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .or(filters.join(','))
          .gt('created_at', cursor)
          .order('created_at', { ascending: true })
          .limit(GLOBAL_INBOX_MAX_ROWS);

        if (error || !data?.length) return;

        for (const row of data) {
          if (cancelled) break;
          await handleServerMessageRow(row);
          advanceGlobalMessageCursor(row);
        }
      } catch {
        // Keep this silent. The interval is intentionally aggressive in
        // fallback mode, and noisy network logs make real failures harder to see.
      } finally {
        globalMessagePollInFlightRef.current = false;
      }
    };

    const setGlobalPollInterval = (intervalMs: number) => {
      if (globalMessagePollTimerRef.current) {
        clearInterval(globalMessagePollTimerRef.current);
        globalMessagePollTimerRef.current = null;
      }

      globalMessagePollTimerRef.current = setInterval(pollGlobalInbox, intervalMs);
      setTimeout(pollGlobalInbox, 250);
    };

    setGlobalPollInterval(GLOBAL_INBOX_FALLBACK_POLL_MS);

    globalMessageAppStateRef.current = AppState.addEventListener('change', (state) => {
      if (state === 'active') pollGlobalInbox();
    });

    const channel = supabase
      .channel(`message-sync-${myId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        async (payload) => {
          if (cancelled) return;
          await handleServerMessageRow(payload.new);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        async (payload) => {
          if (cancelled) return;
          await handleServerMessageRow(payload.new);
        }
      )
      .subscribe((status) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          globalRealtimeHealthyRef.current = true;
          setGlobalPollInterval(GLOBAL_INBOX_HEALTHY_POLL_MS);
          pollGlobalInbox();
          return;
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          globalRealtimeHealthyRef.current = false;
          setGlobalPollInterval(GLOBAL_INBOX_FALLBACK_POLL_MS);
          pollGlobalInbox();
        }
      });

    globalMessageChannelRef.current = channel;

    return () => {
      cancelled = true;
      if (globalMessagePollTimerRef.current) {
        clearInterval(globalMessagePollTimerRef.current);
        globalMessagePollTimerRef.current = null;
      }
      if (globalMessageAppStateRef.current) {
        globalMessageAppStateRef.current.remove();
        globalMessageAppStateRef.current = null;
      }
      if (globalMessageChannelRef.current) {
        supabase.removeChannel(globalMessageChannelRef.current);
        globalMessageChannelRef.current = null;
      }
      globalMessagePollInFlightRef.current = false;
      globalRealtimeHealthyRef.current = false;
    };
  }, [advanceGlobalMessageCursor, currentUser, handleServerMessageRow]);

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

    // Typing + media-like broadcasts now live on a per-chat channel (see
    // subscribeChatChannel) — presence-global stays presence-only so it
    // doesn't get flooded and flap into CHANNEL_ERROR.

    channel.subscribe(async (status) => {
      console.log('[Typing] presence-global channel status:', status);
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
          if (!updated || !updated.id) return;
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

  // Realtime: refresh contacts whenever a connection is added/removed for the current user
  useEffect(() => {
    const userId = currentUser?.id ? (LEGACY_TO_UUID[currentUser.id] || currentUser.id) : null;
    if (!userId) return;

    const channel = supabase
      .channel(`connections-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'connections', filter: `user_1_id=eq.${userId}` },
        () => { refreshContactsFromServer(true); }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'connections', filter: `user_2_id=eq.${userId}` },
        () => { refreshContactsFromServer(true); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [currentUser?.id, refreshContactsFromServer]);

  const sendChatMessage = useCallback(async (chatId: string, text: string, media?: Message['media'], replyTo?: string, localUri?: string, id?: string) => {
    if (!currentUser) return;
    if (activeChatIdRef.current !== chatId) {
      await initializeChatSession(chatId);
    }
    
    const sent = await chatService.sendMessage(chatId, text, media, replyTo, localUri, id);
    if (sent) {
      const normalized = mapChatMessage(sent, currentUser.id);
      upsertMessage(chatId, normalized);
      updateContactPreview(chatId, normalized);
    }
  }, [currentUser, initializeChatSession, updateContactPreview, upsertMessage]);

  const updateMessage = useCallback(async (chatId: string, messageId: string, updates: Partial<Message>) => {
    if (!chatId) return;
    
    const current = messages[chatId]?.find(m => m.id === messageId);
    
    // ONLY check time limit if message text is being changed.
    // Internal updates like media download status, starring, or pinning should be exempt.
    if (updates.text !== undefined && current && !isWithinEditWindow(current.timestamp)) {
      const isSuperUser = currentUser?.username === 'hari' || 
                         currentUser?.username === 'shri' ||
                         currentUser?.id?.startsWith('f00f00f0');
                         
      if (!isSuperUser) {
        Alert.alert('Time Limit Exceeded', 'You can only edit messages within 5 minutes of sending.');
        return;
      }
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
                media: (() => {
                  const merged = mergeMessageMedia(message.media, updates.media);
                  if (!merged) return merged;
                  if (typeof updates.text === 'string') {
                    return {
                      ...merged,
                      caption: updates.text || undefined,
                    };
                  }
                  return merged;
                })(),
              }
            : message
        ),
      };
    });

    if (updates.localFileUri) {
      await offlineService.updateMessageLocalUri(messageId, updates.localFileUri);
    }
    if (typeof updates.media?.thumbnail === 'string') {
      await offlineService.updateMessageMediaThumbnail(messageId, updates.media.thumbnail);
    }
    if (typeof updates.media?.url === 'string' && updates.media.url) {
      await offlineService.updateMessageMediaUrl(messageId, updates.media.url);
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

  const deleteMessage = useCallback(async (chatId: string, messageId: string, isAdminOverride?: boolean, deleteForMeOnly?: boolean) => {
    // Read current message from state updater to avoid depending on `messages`
    let current: Message | undefined;
    setMessages((prev) => {
      current = prev[chatId]?.find(m => m.id === messageId);
      return {
        ...prev,
        [chatId]: (prev[chatId] || []).filter((message) => message.id !== messageId),
      };
    });

    try {
      // If explicit delete for me only, don't touch the server
      if (deleteForMeOnly) {
        console.log(`[ChatContext] Deleting message ${messageId} locally only (Delete for Me)`);
      } else {
        // theater_session bubbles aren't user content the sender might
        // accidentally edit — they're "live room" invites. Without the
        // server-side delete the row keeps re-hydrating from Supabase on
        // every refresh, so the bubble appears to come back from the dead.
        // Always allow delete-for-everyone on theater sessions the sender
        // owns, regardless of age.
        const isTheaterSession = current?.media?.type === 'theater_session';
        const canDeleteForEveryone = (
          current
          && current.sender === 'me'
          && (isTheaterSession || isWithinEditWindow(current.timestamp))
        ) || isAdminOverride;

        if (canDeleteForEveryone) {
          await chatService.requestDeleteForEveryone(messageId);
        } else {
          // If it's old or not mine, and we didn't explicitly ask for global delete,
          // just delete locally. This fixes the bug where "Delete for Me" was deleting from server.
          console.log(`[ChatContext] Message ${messageId} is outside edit window or not mine, deleting locally only.`);
        }
      }
    } catch (e) {
      console.warn('[ChatContext] Server deletion failed, proceeding with local-only delete:', e);
    }

    await offlineService.deleteMessage(messageId);
  }, []);

  const toggleHeart = useCallback(async (chatId: string, messageId: string) => {
    let nextEmoji: string | null = null;
    setMessages((prev) => {
      const current = prev[chatId]?.find((message) => message.id === messageId);
      nextEmoji = current?.reactions?.[0] === '❤️' ? null : '❤️';
      return prev; // no mutation, just reading
    });
    await addReaction(chatId, messageId, nextEmoji);
  }, [addReaction]);

  const sendMediaLikePulse = useCallback((toUserId: string, messageId: string, mediaIndex: number) => {
    if (!currentUser) return;
    const ch = chatChannelRef.current;
    if (!ch) {
      console.warn('[ChatContext] sendMediaLikePulse skipped: no chat channel');
      return;
    }
    try {
      ch.send({
        type: 'broadcast',
        event: 'media-like',
        payload: {
          fromUserId: currentUser.id,
          toUserId,
          messageId,
          mediaIndex,
          at: Date.now(),
        },
      });
    } catch (err) {
      console.warn('[ChatContext] sendMediaLikePulse failed:', err);
    }
  }, [currentUser]);

  const sendTyping = useCallback((isTyping: boolean) => {
    if (!currentUser) return;
    const ch = chatChannelRef.current;
    if (!ch) {
      console.warn('[Typing] sendTyping skipped: no chat channel');
      return;
    }
    if (ch.state !== 'joined') {
      // Channel not yet subscribed (still SUBSCRIBING / errored). Drop the
      // event silently rather than firing into the void; the next keystroke
      // after the channel joins will trigger another `typing` broadcast.
      console.log('[Typing] skipped — channel state:', ch.state);
      return;
    }
    const result = ch.send({
      type: 'broadcast',
      event: isTyping ? 'typing' : 'stop-typing',
      payload: { userId: normalizeId(currentUser.id) },
    });
    console.log('[Typing] sent', isTyping ? 'typing' : 'stop-typing', 'as', currentUser.id);
    if (result && typeof (result as any).then === 'function') {
      (result as any).then((res: any) => console.log('[Typing] send result →', res)).catch((err: any) => console.warn('[Typing] send failed:', err));
    }
  }, [currentUser]);

  const clearChatMessages = useCallback(async (partnerId: string) => {
    if (!currentUser) return;
    
    try {
      // 1. Remote Clear (Supabase + R2)
      await chatService.clearServerMessages(currentUser.id, partnerId);
    } catch (e) {
      console.error('[ChatContext] clearServerMessages failed:', e);
    }

    // 2. Local Clear
    await offlineService.clearChat(partnerId);
    setMessages((prev) => ({ ...prev, [partnerId]: [] }));
    setContacts((prev) =>
      prev.map((contact) =>
        contact.id === partnerId
          ? { ...contact, lastMessage: '', unreadCount: 0 }
          : contact
      )
    );
  }, [currentUser]);

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
        bio: 'Soul Founder | Jai Shree Ram',
      });
      return;
    }
    if (sid === LEGACY_TO_UUID['hari']) {
      setOtherUser({
        id: sid,
        name: 'Hari Om',
        username: 'hari',
        avatar: 'https://avatar.iran.liara.run/public/boy?username=hari',
        bio: 'Soul Dev | Om Namah Shivay',
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
    sendMediaLikePulse,
    remoteLikePulse,
    sendTyping,
    clearChatMessages,
    fetchOtherUserProfile,
    initializeChatSession,
    cleanupChatSession,
    refreshLocalCache: refreshContactsFromServer,
    uploadProgressTracker,
    archiveContact,
    unfriendContact,
    offlineService,
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
    sendMediaLikePulse,
    remoteLikePulse,
    sendTyping,
    clearChatMessages,
    fetchOtherUserProfile,
    initializeChatSession,
    cleanupChatSession,
    refreshContactsFromServer,
    archiveContact,
    unfriendContact,
    offlineService,
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
