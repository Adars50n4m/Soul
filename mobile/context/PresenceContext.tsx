import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../config/supabase';
import { useAuth } from './AuthContext';
import { AppState, AppStateStatus } from 'react-native';

interface PresenceState {
  isOnline: boolean;
  lastSeen: string | null;
}

interface PresenceContextType {
  presenceMap: Record<string, PresenceState>;
  getPresence: (userId: string) => PresenceState;
}

const PresenceContext = createContext<PresenceContextType | undefined>(undefined);

export const PresenceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentUser } = useAuth();
  const [presenceMap, setPresenceMap] = useState<Record<string, PresenceState>>({});
  const heartbeatTimer = useRef<NodeJS.Timeout | null>(null);
  const appState = useRef(AppState.currentState);

  // 1. Fetch initial presence for all profiles
  const fetchInitialPresence = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, is_online, last_seen');
      
      if (data && !error) {
        const newMap: Record<string, PresenceState> = {};
        data.forEach((p: any) => {
          newMap[p.id] = {
            isOnline: p.is_online || false,
            lastSeen: p.last_seen || null
          };
        });
        setPresenceMap(newMap);
      }
    } catch (e) {
      console.warn('[PresenceContext] fetchInitialPresence failed:', e);
    }
  }, []);

  // 2. Heartbeat to update own status
  const updateOwnStatus = useCallback(async (isOnline: boolean) => {
    if (!currentUser?.id) return;
    
    try {
      await supabase
        .from('profiles')
        .update({
          is_online: isOnline,
          last_seen: new Date().toISOString()
        })
        .eq('id', currentUser.id);
    } catch (e) {
      console.warn('[PresenceContext] updateOwnStatus failed:', e);
    }
  }, [currentUser?.id]);

  const startHeartbeat = useCallback(() => {
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    
    // Update immediately
    updateOwnStatus(true);
    
    // Update every 60 seconds
    heartbeatTimer.current = setInterval(() => {
      if (appState.current === 'active') {
        updateOwnStatus(true);
      }
    }, 60000);
  }, [updateOwnStatus]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimer.current) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }
    updateOwnStatus(false);
  }, [updateOwnStatus]);

  // 3. Realtime subscription for changes
  useEffect(() => {
    fetchInitialPresence();

    const channel = supabase
      .channel('public:profiles_presence')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles' },
        (payload) => {
          const updated = payload.new as any;
          setPresenceMap((prev) => ({
            ...prev,
            [updated.id]: {
              isOnline: updated.is_online,
              lastSeen: updated.last_seen
            }
          }));
        }
      )
      .subscribe();

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        console.log('[PresenceContext] App came to foreground - starting heartbeat');
        startHeartbeat();
      } else if (nextAppState.match(/inactive|background/)) {
        console.log('[PresenceContext] App went to background - stopping heartbeat');
        stopHeartbeat();
      }
      appState.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    // Initial heartbeat
    if (currentUser?.id) {
      startHeartbeat();
    }

    return () => {
      subscription.remove();
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      supabase.removeChannel(channel);
    };
  }, [currentUser?.id, fetchInitialPresence]); 

  const getPresence = useCallback((userId: string): PresenceState => {
    return presenceMap[userId] || { isOnline: false, lastSeen: null };
  }, [presenceMap]);

  return (
    <PresenceContext.Provider value={{ presenceMap, getPresence }}>
      {children}
    </PresenceContext.Provider>
  );
};

export const usePresence = () => {
  const context = useContext(PresenceContext);
  if (context === undefined) {
    throw new Error('usePresence must be used within a PresenceProvider');
  }
  return context;
};
