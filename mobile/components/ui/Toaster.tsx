import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Dimensions, TouchableOpacity, Platform } from 'react-native';
import Animated, { 
  FadeInUp, 
  FadeOutUp, 
  Layout, 
  SlideInUp, 
  SlideOutUp,
  useAnimatedStyle,
  withSpring
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { GlassView } from './GlassView';
import { store, ToastItem, ToastType } from './Sileo';

const { width } = Dimensions.get('window');

const TOAST_WIDTH = width - 32;

const STATE_CONFIG: Record<ToastType, { icon: string; color: string; bgColor: string }> = {
  success: { icon: 'check', color: '#10B981', bgColor: 'rgba(16, 185, 129, 0.15)' },
  error: { icon: 'x', color: '#EF4444', bgColor: 'rgba(239, 68, 68, 0.15)' },
  warning: { icon: 'alert-circle', color: '#F59E0B', bgColor: 'rgba(245, 158, 11, 0.15)' },
  info: { icon: 'info', color: '#3B82F6', bgColor: 'rgba(59, 130, 246, 0.15)' },
  action: { icon: 'arrow-right', color: '#EC4899', bgColor: 'rgba(236, 72, 153, 0.15)' },
};

const Toast = ({ item }: { item: ToastItem }) => {
  const config = STATE_CONFIG[item.type];
  
  return (
    <Animated.View
      entering={Platform.OS === 'ios' ? FadeInUp.springify() : SlideInUp.duration(400)}
      exiting={Platform.OS === 'ios' ? FadeOutUp.duration(300) : SlideOutUp.duration(300)}
      layout={Layout.springify()}
      style={styles.toastWrapper}
    >
      <GlassView intensity={95} tint="dark" style={styles.toastContainer}>
        <View style={styles.header}>
          <View style={[styles.badge, { backgroundColor: config.bgColor }]}>
             <Feather name={config.icon as any} size={14} color={config.color} />
          </View>
          <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
        </View>

        {item.description && (
            <View style={styles.descriptionContainer}>
                 {typeof item.description === 'string' ? (
                    <Text style={styles.description}>{item.description}</Text>
                 ) : (
                    item.description
                 )}
            </View>
        )}

        {item.button && (
            <TouchableOpacity 
                style={[styles.button, { backgroundColor: config.bgColor }]} 
                onPress={item.button.onClick}
            >
                <Text style={[styles.buttonText, { color: config.color }]}>{item.button.title}</Text>
            </TouchableOpacity>
        )}
      </GlassView>
    </Animated.View>
  );
};

export const Toaster = ({ position = 'top-center' }: { position?: string }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const unsubscribe = store.subscribe((newToasts) => {
      setToasts(newToasts.filter(t => !t.exiting));
    });
    return () => { unsubscribe(); };
  }, []);

  return (
    <View 
      style={[
        styles.globalWrapper, 
        { top: insets.top + (Platform.OS === 'android' ? 10 : 0) }
      ]} 
      pointerEvents="box-none"
    >
      {toasts.map((item) => (
        <Toast key={item.instanceId} item={item} />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  globalWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 9999,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  toastWrapper: {
    width: TOAST_WIDTH,
    marginBottom: 8,
  },
  toastContainer: {
    borderRadius: 20,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  badge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFF',
    flex: 1,
  },
  descriptionContainer: {
    marginTop: 8,
    paddingLeft: 34,
  },
  description: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.6)',
    lineHeight: 18,
  },
  button: {
    marginTop: 12,
    marginLeft: 34,
    height: 32,
    paddingHorizontal: 16,
    borderRadius: 99,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  buttonText: {
    fontSize: 12,
    fontWeight: '600',
  },
});

export default Toaster;
