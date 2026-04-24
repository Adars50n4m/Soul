import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { statusService } from '../services/StatusService';
import { UserStatusGroup, CachedStatus, PendingUpload } from '../types';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from './AuthContext';
import { supabase } from '../config/supabase';

interface StatusContextType {
  statusGroups: UserStatusGroup[];
  myStatuses: CachedStatus[];
  pendingUploads: PendingUpload[];
  statusUploadProgress: Record<string, number>;
  isStatusSyncing: boolean;
  refreshStatuses: () => Promise<void>;
  addStatus: (localUri: string, mediaType: 'image' | 'video', caption?: string) => Promise<void>;
  updateSoulNote: (text: string) => Promise<void>;
  deleteStatus: (id: string, mediaKey: string) => Promise<void>;
  viewStatus: (id: string, viewerId: string) => Promise<void>;
  retryPendingUploads: () => Promise<void>;
}

export const StatusContext = createContext<StatusContextType | undefined>(undefined);

export const StatusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isReady } = useAuth();
  const [statusGroups, setStatusGroups] = useState<UserStatusGroup[]>([]);
  const [myStatuses, setMyStatuses] = useState<CachedStatus[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [statusUploadProgress, setStatusUploadProgress] = useState<Record<string, number>>({});
  const [isStatusSyncing, setIsStatusSyncing] = useState(false);
  const syncInFlightRef = useRef(false);
  const sortPendingUploads = useCallback(
    (uploads: PendingUpload[]) => [...uploads].sort((a, b) => a.createdAt - b.createdAt),
    []
  );

  const refreshStatuses = useCallback(async () => {
    try {
      const [groups, mine] = await Promise.all([
        statusService.getStatusFeed(),
        statusService.getMyStatuses()
      ]);
      setStatusGroups(groups);
      setMyStatuses(mine);
      
      // Background Sync: Download all media for truly offline access
      const userId = (await statusService.resolveStatusActor())?.id;
      if (userId) {
        statusService.syncAllStatusMedia(userId, groups).catch((e) => {
          console.warn('[StatusContext] Background media sync failed:', e);
        });
      }
    } catch (e) {
      console.error('[StatusContext] Refresh error:', e);
    }
  }, []);

  const refreshPendingUploads = useCallback(async () => {
    try {
      const pending = await statusService.getPendingUploads();
      const sorted = sortPendingUploads(pending);
      setPendingUploads(sorted);
      
      // Clean up progress for items no longer pending
      setStatusUploadProgress(prev => {
        const next = { ...prev };
        const pendingIds = sorted.map(p => p.id);
        Object.keys(next).forEach(id => {
          if (!pendingIds.includes(id)) delete next[id];
        });
        return next;
      });
    } catch (e) {
      console.error('[StatusContext] Pending refresh error:', e);
    }
  }, [sortPendingUploads]);

  const syncPendingUploads = useCallback(async () => {
    if (syncInFlightRef.current) {
      return;
    }

    const currentPendingUploads = sortPendingUploads(await statusService.getPendingUploads());
    setPendingUploads(currentPendingUploads);

    if (currentPendingUploads.length === 0) {
      return;
    }

    const netState = await NetInfo.fetch();
    if (!netState.isConnected) {
      await refreshPendingUploads();
      return;
    }

    syncInFlightRef.current = true;
    setIsStatusSyncing(true);

    try {
      await statusService.processPendingUploads((id, progress) => {
        setStatusUploadProgress(prev => ({ ...prev, [id]: progress }));
      });
    } catch (e) {
      console.error('[StatusContext] Pending sync error:', e);
    } finally {
      syncInFlightRef.current = false;
      setIsStatusSyncing(false);
      await Promise.all([refreshPendingUploads(), refreshStatuses()]);
    }
  }, [refreshPendingUploads, refreshStatuses, sortPendingUploads]);

  useEffect(() => {
    let isMounted = true;
    const lastBackgroundTime = { current: 0 };

    const init = async () => {
      if (!isReady) return;
      try {
        await statusService.cleanupExpiredLocal();
        await Promise.all([refreshStatuses(), refreshPendingUploads()]);
        if (!isMounted) return;

        await syncPendingUploads();
      } catch (e) {
        console.error('[StatusContext] Init error:', e);
      }
    };

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        void refreshStatuses();
        void syncPendingUploads();
      }
    });

    // Real-time: listen for new statuses from other users
    const realtimeChannel = supabase
      .channel('status_feed_realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'statuses' },
        () => {
          console.log('[StatusContext] New status detected via Realtime, refreshing feed...');
          void refreshStatuses();
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'statuses' },
        () => {
          void refreshStatuses();
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'status_views' },
        (payload) => {
          console.log('[StatusContext] New status view detected:', payload.new);
          void refreshStatuses();
        }
      )
      .subscribe();

    init();
    return () => {
      isMounted = false;
      subscription.remove();
      supabase.removeChannel(realtimeChannel);
    };
  }, [isReady, refreshStatuses, refreshPendingUploads, syncPendingUploads]);

  // Clear state on logout
  useEffect(() => {
    if (!isReady) {
      setStatusGroups([]);
      setMyStatuses([]);
      setPendingUploads([]);
    }
  }, [isReady]);

  useEffect(() => {
    if (pendingUploads.length === 0) return;

    let retryCount = 0;
    const MAX_RETRIES = 10;
    const retryInterval = setInterval(() => {
      if (retryCount >= MAX_RETRIES) {
        console.warn('[StatusContext] Max retry attempts reached, stopping auto-sync');
        clearInterval(retryInterval);
        return;
      }
      retryCount++;
      void syncPendingUploads();
    }, 15000); // 15s between retries instead of 8s

    return () => clearInterval(retryInterval);
  }, [isReady, pendingUploads.length, syncPendingUploads]);

  const addStatus = useCallback(async (localUri: string, mediaType: 'image' | 'video', caption?: string) => {
    await statusService.uploadStory(localUri, mediaType, caption);
    await Promise.all([refreshStatuses(), refreshPendingUploads()]);
    void syncPendingUploads();
  }, [refreshPendingUploads, refreshStatuses, syncPendingUploads]);

  const updateSoulNote = useCallback(async (text: string) => {
    await statusService.updateSoulNote(text);
    await refreshStatuses();
  }, [refreshStatuses]);

  const deleteStatus = useCallback(async (id: string, mediaKey: string) => {
    await statusService.deleteMyStatus(id, mediaKey);
    await Promise.all([refreshStatuses(), refreshPendingUploads()]);
  }, [refreshPendingUploads, refreshStatuses]);

  const viewStatus = useCallback(async (id: string, viewerId: string) => {
    await statusService.onStatusViewed(id, viewerId);
    // Prefetch logic handled by StatusService inside feed call or screens
  }, []);

  const retryPendingUploads = useCallback(async () => {
    console.log('[StatusContext] Manually retrying pending uploads...');
    await syncPendingUploads();
  }, [syncPendingUploads]);

  useEffect(() => {
    if (!isReady) return;
    // Listen for connectivity changes to trigger automatic sync
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected) {
        console.log('[StatusContext] Connection restored, triggering sync...');
        void syncPendingUploads();
      }
    });

    return () => unsubscribe();
  }, [isReady, syncPendingUploads]);

  useEffect(() => {
    if (!isReady) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        return;
      }

      if (pendingUploads.length > 0) {
        void syncPendingUploads();
        return;
      }

      void Promise.all([refreshStatuses(), refreshPendingUploads()]);
    });

    return () => subscription.remove();
  }, [isReady, pendingUploads.length, refreshPendingUploads, refreshStatuses, syncPendingUploads]);

  const value = useMemo(() => ({
    statusGroups,
    myStatuses,
    pendingUploads,
    statusUploadProgress,
    isStatusSyncing,
    refreshStatuses,
    addStatus,
    updateSoulNote,
    deleteStatus,
    viewStatus,
    retryPendingUploads
  }), [
    statusGroups,
    myStatuses,
    pendingUploads,
    statusUploadProgress,
    isStatusSyncing,
    refreshStatuses,
    addStatus,
    updateSoulNote,
    deleteStatus,
    viewStatus,
    retryPendingUploads
  ]);

  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
};

export const useStatus = () => {
  const context = useContext(StatusContext);
  if (context === undefined) {
    throw new Error('useStatus must be used within a StatusProvider');
  }
  return context;
};
