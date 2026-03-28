import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

type RouteMotionState = {
  hidden: boolean;
  lastY: number;
  pivotY: number;
};

type ScrollMotionContextValue = {
  getHidden: (routeId: string) => boolean;
  handleScroll: (routeId: string, y: number) => void;
  resetRoute: (routeId: string) => void;
};

const ScrollMotionContext = createContext<ScrollMotionContextValue | undefined>(undefined);

const DEFAULT_THRESHOLD = 14;
const TOP_REVEAL_OFFSET = 24;

export function ScrollMotionProvider({ children }: { children: React.ReactNode }) {
  const routeStateRef = useRef<Record<string, RouteMotionState>>({});
  const [hiddenByRoute, setHiddenByRoute] = useState<Record<string, boolean>>({});

  const setRouteHidden = useCallback((routeId: string, hidden: boolean) => {
    setHiddenByRoute((prev) => {
      if (prev[routeId] === hidden) {
        return prev;
      }
      return { ...prev, [routeId]: hidden };
    });
  }, []);

  const ensureRouteState = useCallback((routeId: string): RouteMotionState => {
    const existing = routeStateRef.current[routeId];
    if (existing) {
      return existing;
    }

    const nextState: RouteMotionState = {
      hidden: false,
      lastY: 0,
      pivotY: 0,
    };
    routeStateRef.current[routeId] = nextState;
    return nextState;
  }, []);

  const handleScroll = useCallback((routeId: string, rawY: number) => {
    const y = Math.max(0, rawY);
    const routeState = ensureRouteState(routeId);
    const delta = y - routeState.lastY;

    if (y <= TOP_REVEAL_OFFSET) {
      routeState.hidden = false;
      routeState.lastY = y;
      routeState.pivotY = y;
      setRouteHidden(routeId, false);
      return;
    }

    if (Math.abs(delta) < 1) {
      routeState.lastY = y;
      return;
    }

    if (delta > 0) {
      if (!routeState.hidden && y - routeState.pivotY >= DEFAULT_THRESHOLD) {
        routeState.hidden = true;
        routeState.pivotY = y;
        setRouteHidden(routeId, true);
      }
    } else if (routeState.hidden && routeState.pivotY - y >= DEFAULT_THRESHOLD) {
      routeState.hidden = false;
      routeState.pivotY = y;
      setRouteHidden(routeId, false);
    }

    if ((delta > 0 && !routeState.hidden) || (delta < 0 && routeState.hidden)) {
      routeState.pivotY = y;
    }

    routeState.lastY = y;
  }, [ensureRouteState, setRouteHidden]);

  const resetRoute = useCallback((routeId: string) => {
    routeStateRef.current[routeId] = {
      hidden: false,
      lastY: 0,
      pivotY: 0,
    };
    setRouteHidden(routeId, false);
  }, [setRouteHidden]);

  const value = useMemo<ScrollMotionContextValue>(() => ({
    getHidden: (routeId: string) => hiddenByRoute[routeId] ?? false,
    handleScroll,
    resetRoute,
  }), [hiddenByRoute, handleScroll, resetRoute]);

  return (
    <ScrollMotionContext.Provider value={value}>
      {children}
    </ScrollMotionContext.Provider>
  );
}

export function useScrollMotion(routeId: string) {
  const context = useContext(ScrollMotionContext);

  if (!context) {
    throw new Error('useScrollMotion must be used within ScrollMotionProvider');
  }

  const { handleScroll, resetRoute, getHidden } = context;

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    handleScroll(routeId, event.nativeEvent.contentOffset.y);
  }, [handleScroll, routeId]);

  const onScrollRaw = useCallback((y: number) => {
    handleScroll(routeId, y);
  }, [handleScroll, routeId]);

  const reset = useCallback(() => {
    resetRoute(routeId);
  }, [resetRoute, routeId]);

  return {
    hidden: getHidden(routeId),
    onScroll,
    onScrollRaw,
    reset,
  };
}
