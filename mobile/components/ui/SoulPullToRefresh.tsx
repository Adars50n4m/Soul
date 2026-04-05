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
  RadialGradient,
  Stop,
} from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';


const THRESHOLD = 110;
const MAX_PULL = 220;
const REFRESH_HEIGHT = 180;
const ANIM_DURATION = 2200;
const TOTAL_REFRESH = 2500;
const CONTAINER_W = 140;

const StarSvg = () => (
  <Svg width={40} height={40} viewBox="0 0 100 100">
    <Defs>
      <SvgLinearGradient id="sparkleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <Stop offset="0%" stopColor="#ffffff" />
        <Stop offset="50%" stopColor="#e8eaed" />
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

const AiWriteMorph = ({ isRefreshing, pullPercentage }) => {
  const starScale = useRef(new Animated.Value(0)).current;
  const starOpacity = useRef(new Animated.Value(1)).current;
  const starRotation = useRef(new Animated.Value(0)).current;
  const starTranslateY = useRef(new Animated.Value(40)).current;
  const starTranslateX = useRef(new Animated.Value(0)).current;
  const auroraRotate = useRef(new Animated.Value(0)).current;
  const auroraOpacity = useRef(new Animated.Value(0)).current;
  const textWidth = useRef(new Animated.Value(0)).current;

  const auroraLoop = useRef(null);
  const starRotateLoop = useRef(null);
  const wasRefreshing = useRef(false);

  // Update star for pull state (non-refreshing)
  useEffect(() => {
    if (!isRefreshing) {
      starScale.setValue(pullPercentage);
      starTranslateY.setValue((1 - pullPercentage) * 30);
      starRotation.setValue(pullPercentage * 0.5); // maps to 180deg via interpolation
      starTranslateX.setValue(0);
      starOpacity.setValue(1);
    }
  }, [pullPercentage, isRefreshing]);

  useEffect(() => {
    if (isRefreshing && !wasRefreshing.current) {
      wasRefreshing.current = true;

      textWidth.setValue(0);
      starScale.setValue(1.5); // Start BIG for impact
      starOpacity.setValue(1);
      auroraOpacity.setValue(0.6);
      auroraRotate.setValue(0);
      starRotation.setValue(0);
      starTranslateY.setValue(40);
      starTranslateX.setValue(0);

      // Aurora glow loop
      auroraLoop.current = Animated.loop(
        Animated.timing(auroraRotate, {
          toValue: 1,
          duration: 4000,
          easing: Easing.linear,
          useNativeDriver: false,
        })
      );
      auroraLoop.current.start();

      // Star continuous rotation
      starRotateLoop.current = Animated.loop(
        Animated.timing(starRotation, {
          toValue: 1,
          duration: 1200,
          easing: Easing.linear,
          useNativeDriver: false,
        })
      );
      starRotateLoop.current.start();

      // 1. Star rises from bottom first (Still BIG)
      Animated.timing(starTranslateY, {
        toValue: 0,
        duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start(() => {
        // 2. SCALE DOWN while starting to write
        Animated.parallel([
          Animated.timing(starScale, {
            toValue: 0.6,
            duration: 400,
            useNativeDriver: false,
          }),
          Animated.timing(starTranslateX, {
            toValue: 1,
            duration: ANIM_DURATION,
            easing: Easing.bezier(0.4, 0, 0.2, 1),
            useNativeDriver: false,
          }),
          Animated.timing(textWidth, {
            toValue: 1,
            duration: ANIM_DURATION,
            easing: Easing.bezier(0.4, 0, 0.2, 1),
            useNativeDriver: false,
          }),
        ]).start();

        // Star disappears near end of writing
        setTimeout(() => {
          starRotateLoop.current?.stop();
          Animated.parallel([
            Animated.timing(starScale, {
              toValue: 0,
              duration: 300,
              useNativeDriver: false,
            }),
            Animated.timing(starOpacity, {
              toValue: 0,
              duration: 300,
              useNativeDriver: false,
            }),
            Animated.timing(auroraOpacity, {
              toValue: 0,
              duration: 500,
              useNativeDriver: false,
            }),
          ]).start(() => {
            auroraLoop.current?.stop();
          });
        }, ANIM_DURATION - 300);
      });
    }

    if (!isRefreshing && wasRefreshing.current) {
      wasRefreshing.current = false;
      auroraLoop.current?.stop();
      starRotateLoop.current?.stop();
    }
  }, [isRefreshing]);

  // Star translateX interpolation
  const starTranslateXInterp = starTranslateX.interpolate({
    inputRange: [0, 0.15, 0.85, 1],
    outputRange: [0, -CONTAINER_W * 0.35, CONTAINER_W * 0.35, CONTAINER_W * 0.35],
  });

  // Text reveal width
  const revealedWidth = textWidth.interpolate({
    inputRange: [0, 0.15, 0.85, 1],
    outputRange: [0, CONTAINER_W * 0.15, CONTAINER_W * 0.85, CONTAINER_W],
  });

  const auroraRotateDeg = auroraRotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const starRotateDeg = starRotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.morphContainer}>
      {/* Aurora glow - Full Screen Impact */}
      <Animated.View
        style={[
          styles.aurora,
          {
            opacity: auroraOpacity,
            transform: [
              { rotate: auroraRotateDeg },
              { scale: 2.5 } // Scale up for massive coverage
            ],
          },
        ]}
      >
        <Svg width="100%" height="100%" viewBox="0 0 200 200">
           <Defs>
             <RadialGradient id="auroraGrad" cx="50%" cy="50%" rx="50%" ry="50%" fx="50%" fy="50%" gradientUnits="userSpaceOnUse">
               <Stop offset="0%" stopColor="#4285F4" stopOpacity="0.8" />
               <Stop offset="50%" stopColor="#9b72cb" stopOpacity="0.5" />
               <Stop offset="100%" stopColor="transparent" stopOpacity="0" />
             </RadialGradient>
           </Defs>
           <Circle cx="100" cy="100" r="100" fill="url(#auroraGrad)" />
        </Svg>
      </Animated.View>

      {/* Text — clipped by animated width */}
      <Animated.View
        style={[
          styles.textClip,
          { width: revealedWidth },
        ]}
      >
        <Text style={styles.soulText}>Soul</Text>
      </Animated.View>

      {/* Star */}
      <Animated.View
        style={[
          styles.starWrap,
          {
            opacity: starOpacity,
            transform: [
              { translateX: starTranslateXInterp },
              { translateY: starTranslateY },
              { scale: starScale },
              { rotate: starRotateDeg },
            ],
          },
        ]}
      >
        <StarSvg />
      </Animated.View>
    </View>
  );
};

export const SoulPullToRefresh = ({ children, onRefresh }) => {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState('idle');

  const pullY = useRef(new Animated.Value(0)).current;
  const pullYValue = useRef(0);
  const statusRef = useRef('idle');
  const startY = useRef(0);
  const scrollTop = useRef(0);

  const setStatusSync = (s) => {
    statusRef.current = s;
    setStatus(s);
  };

  const onScroll = useCallback((e) => {
    scrollTop.current = e.nativeEvent.contentOffset.y;
  }, []);

  const snapBack = useCallback(() => {
    Animated.spring(pullY, {
      toValue: 0,
      useNativeDriver: false,
      tension: 80,
      friction: 10,
    }).start();
    pullYValue.current = 0;
  }, []);

  const lockAt = useCallback((h) => {
    Animated.spring(pullY, {
      toValue: h,
      useNativeDriver: false,
      tension: 120,
      friction: 14,
    }).start();
    pullYValue.current = h;
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gs) => {
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

        const resistance = MAX_PULL * (1 - Math.exp(-dy / 180));
        pullY.setValue(resistance);
        pullYValue.current = resistance;

        if (resistance >= THRESHOLD && statusRef.current !== 'armed') {
          setStatusSync('armed');
          if (Platform.OS !== 'web') {
            const Haptics = require('expo-haptics');
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          }
        } else if (resistance < THRESHOLD && statusRef.current === 'armed') {
          setStatusSync('pulling');
        }
      },
      onPanResponderRelease: () => {
        if (statusRef.current === 'armed') {
          setStatusSync('loading');
          lockAt(REFRESH_HEIGHT);

          onRefresh().finally(() => {
            setTimeout(() => {
              snapBack();
              setStatusSync('idle');
            }, Math.max(0, TOTAL_REFRESH - 500));
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
      <View style={[styles.header, { paddingTop: insets.top + 10 }]} pointerEvents="none">
        <AiWriteMorph
          isRefreshing={status === 'loading'}
          pullPercentage={pullPercentage}
        />
      </View>

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

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 140,
    alignItems: 'center',
    justifyContent: 'flex-end',
    zIndex: 0,
  },
  sheet: {
    flex: 1,
    backgroundColor: '#0a0a0c',
    overflow: 'hidden',
    borderColor: 'rgba(255,255,255,0.05)',
    borderTopWidth: 1,
    zIndex: 10,
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
  morphContainer: {
    width: CONTAINER_W,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  aurora: {
    position: 'absolute',
    top: -100, // Position higher to cover more background
    width: '180%', // Bleed off the edges
    height: 400,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: -1,
  },
  textClip: {
    position: 'absolute',
    overflow: 'hidden',
    height: 60,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  soulText: {
    fontFamily: 'DancingScript_700Bold',
    fontSize: 48,
    color: '#ffffff',
    includeFontPadding: false,
    lineHeight: 56,
  },
  starWrap: {
    position: 'absolute',
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
