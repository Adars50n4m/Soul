import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, Modal, useWindowDimensions, Platform } from 'react-native';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring, 
  withTiming, 
  FadeIn, 
  FadeOut,
  runOnJS,
} from 'react-native-reanimated';
import GlassView from './GlassView';
import { useApp } from '../../context/AppContext';

export interface AlertButton {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
}

export interface GlassAlertProps {
  visible: boolean;
  title: string;
  message?: string;
  buttons?: AlertButton[];
  onClose: () => void;
}

const GlassAlert = ({ visible, title, message, buttons = [], onClose }: GlassAlertProps) => {
  const { width } = useWindowDimensions();
  const { activeTheme } = useApp();
  const scale = useSharedValue(0.9);
  const opacity = useSharedValue(0);

  const [isAlertActive, setIsAlertActive] = React.useState(visible);

  useEffect(() => {
    if (visible) {
      setIsAlertActive(true);
      scale.value = withSpring(1, { damping: 15, stiffness: 150 });
      opacity.value = withTiming(1, { duration: 250 });
    } else {
      scale.value = withTiming(0.9, { duration: 200 });
      opacity.value = withTiming(0, { duration: 200 }, (finished) => {
        if (finished) runOnJS(setIsAlertActive)(false);
      });
    }
  }, [visible]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  if (!isAlertActive) return null;

  const handleButtonPress = (btn: AlertButton) => {
    onClose();
    if (btn.onPress) {
      setTimeout(btn.onPress, 150);
    }
  };

  const defaultButtons: AlertButton[] = buttons.length > 0 ? buttons : [{ text: 'OK', onPress: onClose }];

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
          <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)' }]} />
        </Pressable>

        <Animated.View style={[styles.alertContainer, { width: width * 0.82 }, animatedStyle]}>
          <GlassView intensity={75} tint="dark" style={styles.glassContent}>
            <View style={styles.textContainer}>
              <Text style={styles.title}>{title}</Text>
              {message && <Text style={styles.message}>{message}</Text>}
            </View>

            <View style={styles.buttonContainer}>
              {defaultButtons.map((btn, index) => {
                const isDestructive = btn.style === 'destructive';
                const isCancel = btn.style === 'cancel';
                
                return (
                  <Pressable
                    key={index}
                    onPress={() => handleButtonPress(btn)}
                    style={({ pressed }) => [
                      styles.button,
                      index > 0 && styles.buttonBorder,
                      pressed && styles.buttonPressed,
                    ]}
                  >
                    <Text style={[
                      styles.buttonText,
                      isDestructive && { color: '#ff4d6d', fontWeight: '700' },
                      isCancel && { color: 'rgba(255,255,255,0.6)', fontWeight: '500' },
                      !isDestructive && !isCancel && { color: activeTheme.primary, fontWeight: '600' }
                    ]}>
                      {btn.text}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </GlassView>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  alertContainer: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1.2,
    borderColor: 'rgba(255,255,255,0.25)',
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 15,
  },
  glassContent: {
    padding: 0,
  },
  textContainer: {
    padding: 24,
    alignItems: 'center',
  },
  title: {
    fontSize: 19,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 8,
  },
  message: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    lineHeight: 20,
  },
  buttonContainer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.15)',
    flexDirection: 'row',
  },
  button: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonBorder: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255,255,255,0.15)',
  },
  buttonPressed: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  buttonText: {
    fontSize: 17,
  },
});

export default GlassAlert;
