/**
 * SoulPullToRefresh.tsx
 *
 * Drop-in pull-to-refresh wrapper for Soul app.
 * Wrap your ScrollView/FlatList content with this.
 *
 * Usage:
 *   <SoulPullToRefresh onRefresh={handleRefresh}>
 *     <ScrollView scrollEventThrottle={16} ... >
 *       ...
 *     </ScrollView>
 *   </SoulPullToRefresh>
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View,
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  Easing,
  Platform,
} from 'react-native';
import Svg, {
  Path,
  Circle,
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop,
} from 'react-native-svg';

// ─── Constants ────────────────────────────────────────────────────────────────
const THRESHOLD = 110;        // px — how far to pull to trigger refresh
const MAX_PULL = 180;         // px — max resistance cap
const REFRESH_HEIGHT = 100;   // px — locked height while loading
const ANIM_DURATION = 2200;   // ms — star-write animation duration
const TOTAL_REFRESH = 2500;   // ms — total refresh time before snap back
const CONTAINER_W = 140;      // px — width of the morph logo area

// ─── Star SVG ─────────────────────────────────────────────────────────────────
const StarSvg = () => (
  <Svg width={40} height={40} viewBox="0 0 100 100">
    <Defs>
      <SvgLinearGradient id="sparkleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <Stop offset="0%"   stopColor="#ffffff" />
        <Stop offset="50%"  stopColor="#e8eaed" />
        <Stop offset="100%" stopColor="#a8c7fa" />
      </SvgLinearGradient>
    </Defs>
    <Path
      d="M 50 0 C 50 35 65 50 100 50 C 65 50 50 65 50 100 C 50 65 35 50 0 50 C 35 50 50 35 50 0 Z"
      fill="url(#sparkleGrad)"
    />
    <Circle cx="50" cy="50" r="4" fill="#ffffff" />
  </Svg>
);

// ─── AiWriteMorph ─────────────────────────────────────────────────────────────
interface MorphProps {
  isRefreshing: boolean;
  pullPercentage: number; // 0–1
}

const AiWriteMorph: React.FC<MorphProps> = ({ isRefreshing, pullPercentage }) => {
  // Animated values
  const progress      = useRef(new Animated.Value(0)).current; // 0→1 drives star + text
  const starScale     = useRef(new Animated.Value(1)).current;
  const starOpacity   = useRef(new Animated.Value(1)).current;
  const auroraRotate  = useRef(new Animated.Value(0)).current;
  const auroraOpacity = useRef(new Animated.Value(0)).current;
  const textWidth     = useRef(new Animated.Value(0)).current;

  const auroraLoop    = useRef<Animated.CompositeAnimation | null>(null);
  const wasRefreshing = useRef(false);

  useEffect(() => {
    if (isRefreshing && !wasRefreshing.current) {
      wasRefreshing.current = true;

      // Reset
      progress.setValue(0);
      textWidth.setValue(0);
      starScale.setValue(0.65);
      starOpacity.setValue(1);
      auroraOpacity.setValue(0.6);
      auroraRotate.setValue(0);

      // Aurora loop
      auroraLoop.current = Animated.loop(
        Animated.timing(auroraRotate, {
          toValue: 1,
          duration: 4000,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      auroraLoop.current.start();

      // Star travels across
      Animated.timing(progress, {
        toValue: 1,
        duration: ANIM_DURATION,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: false, // needed for layout-based interpolation
      }).start();

      // Text width reveal (same curve)
      Animated.timing(textWidth, {
        toValue: 1,
        duration: ANIM_DURATION,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: false,
      }).start();

      // Star disappears near end
      setTimeout(() => {
        Animated.parallel([
          Animated.timing(starScale, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.timing(starOpacity, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.timing(auroraOpacity, {
            toValue: 0,
            duration: 500,
            useNativeDriver: true,
          }),
        ]).start(() => {
          auroraLoop.current?.stop();
        });
      }, 1900);
    }

    if (!isRefreshing && wasRefreshing.current) {
      wasRefreshing.current = false;
      auroraLoop.current?.stop();
    }
  }, [isRefreshing]);

  // Star translateX: left-center → left-edge → right-edge → right-edge
  const starTranslateX = progress.interpolate({
    inputRange:  [0,    0.15,                   0.85,                  1],
    outputRange: [0,    -CONTAINER_W * 0.35,    CONTAINER_W * 0.35,   CONTAINER_W * 0.35],
  });

  // Text reveal width: starts at 15% mark, ends at 100%
  const revealedWidth = textWidth.interpolate({
    inputRange:  [0,    0.15,              0.85,              1],
    outputRange: [
      CONTAINER_W * 0.0,
      CONTAINER_W * 0.15,
      CONTAINER_W * 0.85,
      CONTAINER_W,
    ],
  });

  const auroraRotateDeg = auroraRotate.interpolate({
    inputRange:  [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.morphContainer}>
      {/* Aurora glow */}
      <Animated.View
        style={[
          styles.aurora,
          {
            opacity:   isRefreshing ? auroraOpacity : 0,
            transform: [{ rotate: auroraRotateDeg }],
          },
        ]}
      />

      {/* Text — clipped by animated width */}
      <Animated.View
        style={[
          styles.textClip,
          { width: isRefreshing ? revealedWidth : 0 },
        ]}
      >
        <Text style={styles.soulText}>Soul</Text>
      </Animated.View>

      {/* Star */}
      <Animated.View
        style={[
          styles.starWrap,
          {
            opacity: isRefreshing ? starOpacity : 1,
            transform: [
              {
                translateX: isRefreshing
                  ? starTranslateX
                  : 0,
              },
              {
                scale: isRefreshing
                  ? starScale
                  : pullPercentage,           // grows as user pulls
              },
              {
                rotate: isRefreshing
                  ? '0deg'
                  : `${pullPercentage * 90}deg`,
              },
            ],
          },
        ]}
      >
        <StarSvg />
      </Animated.View>
    </View>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────
interface SoulPullToRefreshProps {
  children: React.ReactNode | ((props: { onScroll: (e: any) => void }) => React.ReactNode);
  onRefresh: () => Promise<void>; // your async refresh callback
}

export const SoulPullToRefresh: React.FC<SoulPullToRefreshProps> = ({
  children,
  onRefresh,
}) => {
  type Status = 'idle' | 'pulling' | 'armed' | 'loading';
  const [status, setStatus] = useState<Status>('idle');

  const pullY       = useRef(new Animated.Value(0)).current;
  const pullYValue  = useRef(0);
  const statusRef   = useRef<Status>('idle');
  const startY      = useRef(0);
  const scrollTop   = useRef(0); // track inner scroll position

  const setStatusSync = (s: Status) => {
    statusRef.current = s;
    setStatus(s);
  };

  // Expose a way to update scroll position
  const onScroll = useCallback((e: any) => {
    scrollTop.current = e.nativeEvent.contentOffset.y;
  }, []);

  // Snap back helper
  const snapBack = useCallback(() => {
    Animated.spring(pullY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start();
    pullYValue.current = 0;
  }, []);

  const lockAt = useCallback((h: number) => {
    Animated.spring(pullY, {
      toValue: h,
      useNativeDriver: true,
      tension: 120,
      friction: 14,
    }).start();
    pullYValue.current = h;
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gs) => {
        // Only intercept downward swipe when scroll is at top
        const isPullingDown = gs.dy > 5 && Math.abs(gs.dy) > Math.abs(gs.dx);
        return (
          scrollTop.current <= 0 &&
          isPullingDown &&
          statusRef.current !== 'loading'
        );
      },
      onPanResponderGrant: (e) => {
        startY.current = e.nativeEvent.pageY;
        setStatusSync('pulling');
      },
      onPanResponderMove: (e) => {
        if (statusRef.current === 'loading') return;
        const dy = e.nativeEvent.pageY - startY.current;
        if (dy <= 0) {
           pullY.setValue(0);
           pullYValue.current = 0;
           return;
        }

        // Rubber-band resistance
        const resistance = MAX_PULL * (1 - Math.exp(-dy / 180));
        pullY.setValue(resistance);
        pullYValue.current = resistance;

        if (resistance >= THRESHOLD && statusRef.current !== 'armed') {
          setStatusSync('armed');
        } else if (resistance < THRESHOLD && statusRef.current === 'armed') {
          setStatusSync('pulling');
        }
      },
      onPanResponderRelease: () => {
        if (statusRef.current === 'armed') {
          setStatusSync('loading');
          lockAt(REFRESH_HEIGHT);

          // Call user's refresh
          onRefresh().finally(() => {
            setTimeout(() => {
              snapBack();
              setStatusSync('idle');
            }, Math.max(0, TOTAL_REFRESH - 500)); // leave a little room
          });
        } else {
          snapBack();
          setStatusSync('idle');
        }
      },
    })
  ).current;

  const pullYDisplay = pullY.interpolate({
    inputRange: [0, MAX_PULL],
    outputRange: [0, MAX_PULL],
    extrapolate: 'clamp',
  });

  const pullPercentage =
    status === 'loading'
      ? 1
      : Math.min(1, pullYValue.current / THRESHOLD);

  return (
    <View style={styles.root} {...panResponder.panHandlers}>
      {/* The reveal header behind the sheet */}
      <View style={styles.header} pointerEvents="none">
        <AiWriteMorph
          isRefreshing={status === 'loading'}
          pullPercentage={pullPercentage}
        />
      </View>

      {/* The sliding sheet */}
      <Animated.View
        style={[
          styles.sheet,
          {
            transform: [{ translateY: pullYDisplay }],
            borderTopLeftRadius: pullYValue.current > 5 ? 32 : 0,
            borderTopRightRadius: pullYValue.current > 5 ? 32 : 0,
          },
        ]}
      >
        {typeof children === 'function' ? children({ onScroll }) : children}
      </Animated.View>
    </View>
  );
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },

  // Behind-the-sheet header that shows the logo
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 70,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 0,
  },

  // The draggable content sheet
  sheet: {
    flex: 1,
    backgroundColor: '#0a0a0c',
    overflow: 'hidden',
    borderColor: 'rgba(255,255,255,0.05)',
    borderTopWidth: 1,
    zIndex: 10,

    // Shadow above sheet
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -8 },
        shadowOpacity: 0.9,
        shadowRadius: 20,
      },
      android: {
        elevation: 20,
      },
    }),
  },

  // Morph logo container
  morphContainer: {
    width: CONTAINER_W,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },

  // Conic aurora (approximated with radial in RN)
  aurora: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'transparent',
    // Soft blue glow
    shadowColor: '#4285F4',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 30,
    elevation: 8,
  },

  // Clip container for the text reveal
  textClip: {
    position: 'absolute',
    overflow: 'hidden',
    height: 60,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },

  soulText: {
    fontFamily: Platform.OS === 'ios' ? 'DancingScript_700Bold' : 'DancingScript_700Bold',
    fontSize: 48,
    color: '#ffffff',
    includeFontPadding: false,
    lineHeight: 56,
  },

  starWrap: {
    position: 'absolute',
    // drop-shadow glow
    ...Platform.select({
      ios: {
        shadowColor: '#a8c7fa',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.8,
        shadowRadius: 8,
      },
    }),
  },
});
