import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useMemo } from 'react';
import { statusService } from '../services/StatusService';
import { storageService } from '../services/StorageService';
import { useAuth } from './AuthContext';
import { type StatusUpdate } from '../types';
import { Alert } from 'react-native';

interface StatusContextType {
  stories: StatusUpdate[];
  notes: any[];
  uploadingStory: { localUri: string; mediaType: 'image' | 'video'; progress: number; caption?: string } | null;
  refreshStatuses: () => Promise<void>;
  addStory: (params: { mediaUrl: string; localUri?: string; mediaType: 'image' | 'video'; caption?: string; music?: any }) => Promise<boolean>;
  updateNote: (text: string | null) => Promise<boolean>;
  deleteStory: (id: string) => Promise<void>;
  toggleStoryLike: (id: string) => Promise<void>;
  viewStory: (id: string) => Promise<void>;
}

export const StatusContext = createContext<StatusContextType | undefined>(undefined);

export const StatusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentUser } = useAuth();
  const [stories, setStories] = useState<StatusUpdate[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [uploadingStory, setUploadingStory] = useState<{ localUri: string; mediaType: 'image' | 'video'; progress: number; caption?: string } | null>(null);

  const refreshStatuses = useCallback(async () => {
    if (!currentUser) return;
    
    try {
      const [fetchedStories, fetchedNotes] = await Promise.all([
        statusService.fetchActiveStories(currentUser.id),
        statusService.fetchActiveNotes(currentUser.id)
      ]);
      
      console.log(`[StatusContext] Fetched ${fetchedStories?.length || 0} stories and ${fetchedNotes?.length || 0} notes`);
      setStories(fetchedStories || []);
      setNotes(fetchedNotes || []);
    } catch (e) {
      console.error('[StatusContext] Error refreshing statuses:', e);
    }
  }, [currentUser]);

  useEffect(() => {
    refreshStatuses();
    // Refresh every 5 minutes to catch expiry
    const interval = setInterval(refreshStatuses, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refreshStatuses]);

  const addStory = useCallback(async (params: { mediaUrl: string; localUri?: string; mediaType: 'image' | 'video'; caption?: string; music?: any }) => {
    if (!currentUser) return false;
    
    // If localUri is provided, we handle upload in background
    if (params.localUri) {
      console.log(`[StatusContext] Starting background upload for status: ${params.localUri}`);
      
      // Immediately set placeholder state for UI
      setUploadingStory({
        localUri: params.localUri,
        mediaType: params.mediaType,
        progress: 0,
        caption: params.caption
      });

      // Background logic
      setTimeout(() => {
        (async () => {
          let lastProgress = 0;
          try {
            // 1. Upload media with timeout check
            const uploadPromise = storageService.uploadImage(
              params.localUri!, 
              'status-media', 
              currentUser.id,
              (p: number) => {
                setUploadingStory(prev => prev ? { ...prev, progress: p } : null);
              }
            );

            const timeoutPromise = new Promise<string>((_, reject) => 
              setTimeout(() => reject(new Error('Upload timed out after 30s')), 30000)
            );

            const uploadedUrl = await Promise.race([uploadPromise, timeoutPromise]);

            if (!uploadedUrl) {
              throw new Error('Storage service returned empty URL.');
            }

            console.log('[StatusContext] Media uploaded, posting to database...');
            // 2. Post to DB
            const posted = await statusService.postStory({
              userId: currentUser.id,
              userName: currentUser.name || currentUser.username || 'User',
              userAvatar: currentUser.avatar || '',
              mediaUrl: uploadedUrl,
              mediaType: params.mediaType,
              caption: params.caption,
              music: params.music
            });

            if (posted) {
              console.log('[StatusContext] Background story post successful');
              await refreshStatuses();
              setUploadingStory(null);
            } else {
               throw new Error('Database rejected the status record.');
            }
          } catch (err: any) {
            console.error('[StatusContext] Background status error:', err);
            
            let errorMessage = err.message || 'Unknown upload error';
            if (errorMessage.includes('Aborted')) errorMessage = 'Upload timed out. Please check your internet connection.';
            if (errorMessage.includes('Network')) errorMessage = 'Network error. Are you connected to the internet?';
            
            Alert.alert(
              'Upload Failed', 
              `${errorMessage}`
            );
            
            setUploadingStory(null);
          }
        })();
      }, 0);

      return true; // Success in triggering the background work
    }

    // Traditional way if mediaUrl is already public
    const success = await statusService.postStory({
      userId: currentUser.id,
      userName: currentUser.name || currentUser.username || 'User',
      userAvatar: currentUser.avatar || '',
      mediaUrl: params.mediaUrl,
      mediaType: params.mediaType,
      caption: params.caption,
      music: params.music
    });
    
    if (success) {
      await refreshStatuses();
    }
    return success;
  }, [currentUser, refreshStatuses]);

  const updateNote = useCallback(async (text: string | null) => {
    if (!currentUser) return false;
    
    const success = await statusService.postNote(currentUser.id, text);
    if (success) {
      await refreshStatuses();
    }
    return success;
  }, [currentUser, refreshStatuses]);

  const deleteStory = useCallback(async (id: string) => {
    if (!currentUser) return;
    const success = await statusService.deleteStory(id, currentUser.id);
    if (success) {
      setStories(prev => prev.filter(s => s.id !== id));
    }
  }, [currentUser]);

  const toggleStoryLike = useCallback(async (id: string) => {
    if (!currentUser) return;
    await statusService.likeStory(id, currentUser.id);
    await refreshStatuses();
  }, [currentUser, refreshStatuses]);

  const viewStory = useCallback(async (id: string) => {
    if (!currentUser) return;
    await statusService.viewStory(id, currentUser.id);
    // Silent update locally if needed, or refresh
  }, [currentUser]);

  const value = useMemo(() => ({
    stories,
    notes,
    uploadingStory,
    refreshStatuses,
    addStory,
    updateNote,
    deleteStory,
    toggleStoryLike,
    viewStory
  }), [stories, notes, uploadingStory, refreshStatuses, addStory, updateNote, deleteStory, toggleStoryLike, viewStory]);

  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
};

export const useStatus = () => {
  const context = useContext(StatusContext);
  if (context === undefined) {
    throw new Error('useStatus must be used within a StatusProvider');
  }
  return context;
};
