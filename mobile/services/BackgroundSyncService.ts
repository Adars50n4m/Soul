/**
 * BackgroundSyncService - Silent Push Notifications & Background Fetch
 * 
 * Handles background sync for WhatsApp-style "Magic Loading" experience.
 * Uses expo-background-fetch and expo-task-manager to fetch messages silently.
 */

import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
// import * as Notifications from 'expo-notifications';
import { supabase } from '../config/supabase';
import { offlineService } from './LocalDBService';

const BACKGROUND_SYNC_TASK = 'background-sync-messages';
const SILENT_SYNC_INTERVAL = 15 * 60; // 15 minutes (minimum allowed by iOS/Android)

// Track if task is registered
let isTaskRegistered = false;

/**
 * Background sync task definition
 * This runs when the app is in background or terminated
 */
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    console.log('[BackgroundSync] Starting background sync...');
    
    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.log('[BackgroundSync] No authenticated user, skipping');
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }
    
    // Fetch unread messages from Supabase
    const syncedCount = await syncMessagesFromServer(user.id);
    
    console.log(`[BackgroundSync] Synced ${syncedCount} messages`);
    
    if (syncedCount > 0) {
      // Show local notification for new messages
      await showSyncNotification(syncedCount);
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }
    
    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (error) {
    console.error('[BackgroundSync] Error:', error);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

/**
 * Sync messages from Supabase server to local database
 */
async function syncMessagesFromServer(userId: string): Promise<number> {
  try {
    // Get last sync timestamp from local DB
    const lastSyncTime = await getLastSyncTime();
    
    // Fetch messages newer than last sync
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .gt('created_at', lastSyncTime)
      .order('created_at', { ascending: true });
    
    if (error) {
      console.error('[BackgroundSync] Supabase error:', error);
      return 0;
    }
    
    if (!messages || messages.length === 0) {
      return 0;
    }
    
    // Save each message to local DB
    for (const msg of messages) {
      const isMe = msg.sender_id === userId;
      const chatId = isMe ? msg.receiver_id : msg.sender_id;
      
      await offlineService.saveMessage(chatId, {
        id: msg.id,
        sender: isMe ? 'me' : 'them',
        text: msg.text || '',
        timestamp: msg.created_at,
        status: msg.status || 'sent',
        media: msg.media_url ? {
          type: msg.media_type || 'image',
          url: msg.media_url,
          caption: msg.media_caption
        } : undefined,
        replyTo: msg.reply_to_id,
        // Media status for offline handling
        mediaStatus: msg.media_url ? 'not_downloaded' : undefined
      });
      
      // Update contact's last message
      await updateContactLastMessage(chatId, msg);
    }
    
    // Update last sync time
    await setLastSyncTime(new Date().toISOString());
    
    return messages.length;
  } catch (error) {
    console.error('[BackgroundSync] Sync error:', error);
    return 0;
  }
}

/**
 * Update contact's last message preview
 */
async function updateContactLastMessage(contactId: string, msg: any): Promise<void> {
  try {
    // Get existing contact
    const contacts = await offlineService.getContacts();
    const existingContact = contacts.find(c => c.id === contactId);
    
    if (existingContact) {
      // Update last message
      await offlineService.saveContact({
        ...existingContact,
        lastMessage: msg.text?.substring(0, 50) || (msg.media_url ? '📷 Media' : ''),
        unreadCount: (existingContact.unreadCount || 0) + (msg.sender_id !== contactId ? 0 : 1)
      });
    } else {
      // Fetch contact info from Supabase
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', contactId)
        .single();
      
      if (profile) {
        await offlineService.saveContact({
          id: contactId,
          name: profile.name || 'Unknown',
          avatar: profile.avatar || '',
          status: 'offline',
          lastMessage: msg.text?.substring(0, 50) || '📷 Media',
          unreadCount: 1
        });
      }
    }
  } catch (error) {
    console.error('[BackgroundSync] Update contact error:', error);
  }
}

/**
 * Show local notification for synced messages
 */
async function showSyncNotification(count: number): Promise<void> {
  try {
    const Notifications = require('expo-notifications');
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'SoulSync',
        body: `You have ${count} new message${count > 1 ? 's' : ''}`,
        sound: false,
        priority: Notifications.AndroidNotificationPriority.LOW,
      },
      trigger: null,
    });
  } catch (error) {
    console.error('[BackgroundSync] Notification error:', error);
  }
}

/**
 * Get last sync timestamp from AsyncStorage
 */
async function getLastSyncTime(): Promise<string> {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const time = await AsyncStorage.getItem('last_sync_time');
    return time || new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Set last sync timestamp in AsyncStorage
 */
async function setLastSyncTime(time: string): Promise<void> {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem('last_sync_time', time);
  } catch (error) {
    console.error('[BackgroundSync] Save sync time error:', error);
  }
}

/**
 * Register background sync task
 */
export async function registerBackgroundSync(): Promise<boolean> {
  try {
    if (isTaskRegistered) {
      console.log('[BackgroundSync] Task already registered');
      return true;
    }
    
    // Check if task is already registered
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (isRegistered) {
      console.log('[BackgroundSync] Task already registered in system');
      isTaskRegistered = true;
      return true;
    }
    
    // Register the background fetch task
    await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
      minimumInterval: SILENT_SYNC_INTERVAL,
      stopOnTerminate: false, // Continue after app termination
      startOnBoot: true, // Start on device boot (Android)
    });
    
    isTaskRegistered = true;
    console.log('[BackgroundSync] Task registered successfully');
    return true;
  } catch (error) {
    console.error('[BackgroundSync] Registration error:', error);
    return false;
  }
}

/**
 * Unregister background sync task
 */
export async function unregisterBackgroundSync(): Promise<void> {
  try {
    await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
    isTaskRegistered = false;
    console.log('[BackgroundSync] Task unregistered');
  } catch (error) {
    console.error('[BackgroundSync] Unregister error:', error);
  }
}

/**
 * Get background fetch status
 */
export async function getBackgroundFetchStatus(): Promise<string> {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    switch (status) {
      case BackgroundFetch.BackgroundFetchStatus.Restricted:
        return 'restricted';
      case BackgroundFetch.BackgroundFetchStatus.Denied:
        return 'denied';
      case BackgroundFetch.BackgroundFetchStatus.Available:
        return 'available';
      default:
        return 'unknown';
    }
  } catch (error) {
    console.error('[BackgroundSync] Status error:', error);
    return 'error';
  }
}

/**
 * Force immediate sync (for testing or manual refresh)
 */
export async function forceSyncNow(): Promise<number> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.log('[BackgroundSync] No user for force sync');
      return 0;
    }
    
    return await syncMessagesFromServer(user.id);
  } catch (error) {
    console.error('[BackgroundSync] Force sync error:', error);
    return 0;
  }
}

/**
 * Handle silent push notification
 * Called when a silent push is received
 */
export async function handleSilentPush(notification: any): Promise<void> {
  console.log('[BackgroundSync] Silent push received');
  
  // Check if this is a content-available notification (silent)
  const data = notification.request.content.data;
  if (data?.silent || data?.['content-available'] === 1) {
    console.log('[BackgroundSync] Processing silent notification');
    await forceSyncNow();
  }
}

/**
 * Setup notification listener for silent pushes
 */
export function setupSilentPushListener(): () => void {
  try {
    const Notifications = require('expo-notifications');
    const subscription = Notifications.addNotificationReceivedListener(handleSilentPush);
    return () => {
      subscription.remove();
    };
  } catch {
    return () => {};
  }
}

export const backgroundSyncService = {
  register: registerBackgroundSync,
  unregister: unregisterBackgroundSync,
  getStatus: getBackgroundFetchStatus,
  forceSync: forceSyncNow,
  setupListener: setupSilentPushListener,
};
