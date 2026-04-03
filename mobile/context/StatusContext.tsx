import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { statusService } from '../services/StatusService';
import { UserStatusGroup, CachedStatus, PendingUpload } from '../types';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from './AuthContext';

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
        statusService.syncAllStatusMedia(userId, groups).catch(() => {});
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

    init();

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        const now = Date.now();
        const FIVE_MINUTES = 5 * 60 * 1000;
        
        // Only refresh if it's been more than 5 minutes since last background
        if (lastBackgroundTime.current > 0 && (now - lastBackgroundTime.current > FIVE_MINUTES)) {
          console.log('[StatusContext] App returned to foreground after 5+ mins, refreshing...');
          void refreshStatuses();
        }
        lastBackgroundTime.current = 0;
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        lastBackgroundTime.current = Date.now();
      }
    });

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, [isReady, refreshPendingUploads, refreshStatuses, syncPendingUploads]);

  useEffect(() => {
    if (pendingUploads.length === 0) {
      return;
    }

    const retryInterval = setInterval(() => {
      void syncPendingUploads();
    }, 8000);

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
