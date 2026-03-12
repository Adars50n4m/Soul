import React, { memo, useMemo, useState, useEffect, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { AppProvider, useApp } from './AppContext.tsx';
import { getActiveStreams, onStreamsChange } from './src/webrtc/useWebRTC';

// ============================================================================
// ERROR BOUNDARY - Catches React errors and shows graceful error UI
// ============================================================================
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#fff',
          fontFamily: 'system-ui, sans-serif',
          padding: '20px'
        }}>
          <div style={{
            maxWidth: '400px',
            textAlign: 'center',
            padding: '40px',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '20px',
            border: '1px solid rgba(255,255,255,0.1)'
          }}>
            <div style={{ fontSize: '48px', marginBottom: '20px' }}>⚠️</div>
            <h1 style={{ fontSize: '24px', marginBottom: '12px', color: '#ff6b6b' }}>
              Something went wrong
            </h1>
            <p style={{ color: '#888', marginBottom: '24px', fontSize: '14px' }}>
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <button
              onClick={this.handleRetry}
              style={{
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                border: 'none',
                color: 'white',
                padding: '12px 32px',
                borderRadius: '12px',
                fontSize: '16px',
                cursor: 'pointer',
                fontWeight: '600'
              }}
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.2)',
                color: '#888',
                padding: '12px 24px',
                borderRadius: '12px',
                fontSize: '14px',
                cursor: 'pointer',
                marginLeft: '12px'
              }}
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Screens
import HomeScreen from './screens/HomeScreen.tsx';
import SingleChatScreen from './screens/SingleChatScreen.tsx';
import ContactsScreen from './screens/ContactsScreen.tsx';
import StatusScreen from './screens/StatusScreen.tsx';
import CallsScreen from './screens/CallsScreen.tsx';
import ProfileScreen from './screens/ProfileScreen.tsx';
import VideoCallScreen from './screens/VideoCallScreen.tsx';
import AudioCallScreen from './screens/AudioCallScreen.tsx';

// ============================================================================
// CALL SERVICE - Handles persistent call state across app
// ============================================================================
class CallService {
  private activeCallState: {
    callId: string | null;
    isActive: boolean;
    isMinimized: boolean;
    remoteUser: any;
  } = {
    callId: null,
    isActive: false,
    isMinimized: false,
    remoteUser: null,
  };

  private listeners: Set<Function> = new Set();

  subscribe(listener: Function) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener(this.activeCallState));
  }

  startCall(callId: string, remoteUser: any) {
    this.activeCallState = {
      callId,
      isActive: true,
      isMinimized: false,
      remoteUser,
    };
    this.notifyListeners();
  }

  minimizeCall(minimize: boolean) {
    this.activeCallState.isMinimized = minimize;
    this.notifyListeners();
  }

  endCall() {
    this.activeCallState = {
      callId: null,
      isActive: false,
      isMinimized: false,
      remoteUser: null,
    };
    this.notifyListeners();
  }

  getState() {
    return { ...this.activeCallState };
  }

  isCallActive() {
    return this.activeCallState.isActive;
  }
}

const callService = new CallService();

// ============================================================================
// PIP OVERLAY - Reliable Picture-in-Picture Video Window
// ============================================================================
const PipOverlay: React.FC = () => {
  const { activeCall, contacts, toggleMinimizeCall } = useApp();
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const dragStart = useRef({ current: { x: 0, y: 0 } });
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const [callState, setCallState] = useState(callService.getState());

  // Subscribe to global call state
  useEffect(() => {
    const unsubscribe = callService.subscribe((state) => {
      setCallState(state);
    });
    return unsubscribe;
  }, []);

  // Restore position from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('pip-position');
    if (saved) {
      try {
        const pos = JSON.parse(saved);
        setPosition(pos);
      } catch {}
    }
    setHasHydrated(true);
  }, []);

  // Handle resize and keep PiP in bounds
  const handleResize = () => {
    setPosition((prev) => ({
      x: Math.min(prev.x, window.innerWidth - 120),
      y: Math.min(prev.y, window.innerHeight - 150),
    }));
  };

  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Drag handlers with proper touch support
  const handleStart = (e: any) => {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    setIsDragging(true);
    setHasHydrated(true);
    dragStart.current = { current: { x: clientX - position.x, y: clientY - position.y } };
  };

  const handleMove = (e: any) => {
    if (!isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const newX = clientX - dragStart.current.current.x;
    const newY = clientY - dragStart.current.current.y;

    let newX_bounded = newX;
    let newY_bounded = newY;
    const margin = 12;
    newX_bounded = Math.max(margin, Math.min(window.innerWidth - 110 - margin, newX_bounded));
    newY_bounded = Math.max(margin, Math.min(window.innerHeight - 150 - margin, newY_bounded));
    setPosition({ x: newX_bounded, y: newY_bounded });
  };

  const handleEnd = () => {
    setIsDragging(false);
    localStorage.setItem('pip-position', JSON.stringify(position));
  };

  useEffect(() => {
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchend', handleEnd);
    return () => {
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [position]);

  // Return null if no active call or not hydrated
  if (!hasHydrated || !callState.isActive) return null;

  return (
    <div
      onMouseDown={handleStart}
      onTouchStart={handleStart}
      onMouseMove={handleMove}
      onTouchMove={handleMove}
      onClick={() => {}}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transition: isDragging ? 'none' : 'all 0.15s cubic-bezier',
      }}
      className="fixed z-[999] w-[110px] h-[150px] rounded-[2.5rem]"
    >
      <div className="absolute inset-0 bg-black/80 backdrop-blur rounded-[2.5rem] overflow-hidden">
        {callState.isActive && activeCall.type === 'video' ? (
          <video
            ref={pipVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover opacity-70"
            draggable={false}
          />
        ) : null}
      </div>

      <div className="w-full h-full flex flex-col items-center justify-center">
        <div className="flex gap-1.5 items-center">
          <div className="size-1.5 bg-primary rounded-full animate-pulse" />
          <span className="size-1.5 bg-primary rounded-full"></span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// HOME INDICATOR - Safe Area Bottom Indicator
// ============================================================================
const HomeIndicator: React.FC = () => (
  <div className="fixed bottom-1 w-24 h-1 bg-white/5 rounded-full"></div>
);

// ============================================================================
// BOTTOM NAVIGATION
// ============================================================================
const BottomNav = memo(() => {
  const location = useLocation();
  const tabs = useMemo(
    () => [
      { path: '/', icon: 'home', label: 'Sync' },
      { path: '/status', icon: 'blur_circular', label: 'Pulse' },
      { path: '/calls', icon: 'call', label: 'Mesh' },
      { path: '/contacts', icon: 'contacts', label: 'Web' },
      { path: '/settings', icon: 'settings', label: 'Core' },
    ],
    []
  );

  const activeTab = useMemo(() => {
    if (location.pathname === '/') return '/';
    const match = tabs.find((t) => t.path !== '/' && location.pathname.startsWith(t.path));
    return match?.path ?? '/';
  }, [location.pathname, tabs]);

  const hideNav =
    location.pathname.includes('/chat/') ||
    location.pathname.includes('/video-call/') ||
    location.pathname.includes('/audio-call/') ||
    location.pathname.includes('/profile/');

  if (hideNav) return null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-[80] px-6 pb-6">
      <div className="liquid-glass rounded-[2rem] p-2 flex items-center">
        {tabs.map((tab) => (
          <Link
            key={tab.path}
            to={tab.path}
            className="size-14 rounded-full border border-primary/30 flex items-center justify-center text-primary"
          >
            <i className="material-icons">{tab.icon}</i>
          </Link>
        ))}
      </div>
    </nav>
  );
});

// ============================================================================
// MAIN APP CONTENT
// ============================================================================
const AppContent: React.FC = () => {
  const location = useLocation();
  const { activeCall, isCallMinimized } = useApp();

  return (
    <div>
      <LayoutGroup>
        <AnimatePresence initial={false} custom={location.pathname}>
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Routes location={location} key={location.pathname}>
              <Route path="/" element={<HomeScreen key="home" />} />
              <Route path="/chat/:id" element={<SingleChatScreen key="chat" />} />
              <Route path="/status" element={<StatusScreen key="status" />} />
              <Route path="/calls" element={<CallsScreen key="calls" />} />
              <Route path="/contacts" element={<ContactsScreen key="contacts" />} />
              <Route path="/profile/:id" element={<ProfileScreen key="profile" />} />
              <Route path="/settings" element={<SettingsScreen key="settings" />} />
              <Route path="/video-call/:id" element={<VideoCallScreen key="video" />} />
              <Route path="/audio-call/:id" element={<AudioCallScreen key="audio" />} />
            </Routes>
          </motion.div>
        </AnimatePresence>

        <BottomNav />
        <PipOverlay />
        <HomeIndicator />
      </LayoutGroup>
    </div>
  );
};

// ============================================================================
// MAIN APP COMPONENT
// ============================================================================
const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <AppProvider>
        <Router>
          <AppContent />
        </Router>
      </AppProvider>
    </ErrorBoundary>
  );
};

export default App;
export { callService };