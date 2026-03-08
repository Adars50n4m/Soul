import React from 'react';
import { ColorValue } from 'react-native';

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'action';

export interface ToastOptions {
  id?: string;
  title: string;
  description?: string | React.ReactNode;
  duration?: number | null;
  fill?: ColorValue;
  styles?: {
    title?: string;
    description?: string;
    badge?: string;
    button?: string;
  };
  button?: {
    title: string;
    onClick: () => void;
  };
  onDismiss?: () => void;
}

export interface ToastItem extends ToastOptions {
  id: string;
  type: ToastType;
  instanceId: string;
  exiting?: boolean;
}

type Listener = (toasts: ToastItem[]) => void;

class SileoStore {
  private toasts: ToastItem[] = [];
  private listeners: Set<Listener> = new Set();

  private emit() {
    this.listeners.forEach((fn) => fn([...this.toasts]));
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  show(type: ToastType, options: ToastOptions) {
    const id = options.id || `sileo-${Math.random().toString(36).slice(2, 9)}`;
    const instanceId = Math.random().toString(36).slice(2, 9);
    
    const item: ToastItem = {
      ...options,
      id,
      type,
      instanceId,
    };

    // Remove existing with same ID if any
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.toasts.push(item);
    this.emit();

    if (options.duration !== null) {
      setTimeout(() => {
        this.dismiss(id);
      }, options.duration || 6000);
    }

    return id;
  }

  dismiss(id: string) {
    const toast = this.toasts.find((t) => t.id === id);
    if (!toast || toast.exiting) return;

    // Mark as exiting first for animation
    this.toasts = this.toasts.map((t) => 
      t.id === id ? { ...t, exiting: true } : t
    );
    this.emit();

    // Remove after short delay
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.emit();
      toast.onDismiss?.();
    }, 400);
  }

  getToasts() {
    return this.toasts;
  }
}

export const store = new SileoStore();

/**
 * Native Sileo API - Preserves the web library's usage pattern.
 */
export const sileo = {
  success: (opts: ToastOptions) => store.show('success', opts),
  error: (opts: ToastOptions) => store.show('error', opts),
  warning: (opts: ToastOptions) => store.show('warning', opts),
  info: (opts: ToastOptions) => store.show('info', opts),
  action: (opts: ToastOptions) => store.show('action', opts),
  show: (opts: ToastOptions) => store.show('info', opts), // Default to info
  dismiss: (id: string) => store.dismiss(id),
  
  /**
   * Promise wrapper for sileo
   */
  promise: <T,>(
    promise: Promise<T>,
    options: {
      loading: { title: string };
      success: (data: T) => ToastOptions;
      error: (err: any) => ToastOptions;
    }
  ) => {
    const id = store.show('info', { ...options.loading, duration: null });
    
    promise
      .then((data) => {
        const successOpts = options.success(data);
        store.show('success', { ...successOpts, id, duration: 6000 });
      })
      .catch((err) => {
        const errorOpts = options.error(err);
        store.show('error', { ...errorOpts, id, duration: 6000 });
      });
      
    return promise;
  }
};
