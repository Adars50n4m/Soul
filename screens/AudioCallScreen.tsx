
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../AppContext.tsx';
import { useWebRTC } from '../src/webrtc/useWebRTC';

const AudioCallScreen: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const { contacts, activeCall, endCall, toggleMinimizeCall, toggleMute } = useApp();
  const [seconds, setSeconds] = useState(0);

  const contact = contacts.find(c => c.id === id) || (activeCall ? contacts.find(c => c.id === activeCall.contactId) : null);

  const roomId = activeCall?.roomId || (contact ? `callRoom-${contact.id}` : '');

  const { remoteStream, cleanup } = useWebRTC({
    roomId,
    callType: 'audio',
    isMuted: activeCall?.isMuted ?? false,
    active: !!(activeCall && !activeCall.isMinimized && contact),
  });

  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // Attach remote audio stream
  useEffect(() => {
    if (remoteAudioRef.current && remoteStream) {
      remoteAudioRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (!activeCall) {
      navigate('/');
      return;
    }

    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - (activeCall?.startTime || Date.now())) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [activeCall, navigate]);

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const handleMinimize = () => {
    toggleMinimizeCall(true);
    navigate(-1);
  };

  const handleEndCall = () => {
    cleanup();
    endCall();
    navigate(-1);
  };

  if (!activeCall || activeCall.isMinimized || !contact) return null;

  return (
    <div className="relative flex h-screen w-full flex-col bg-black overflow-hidden animate-fade-in z-[100]">
      {/* Hidden audio element for remote audio playback */}
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {/* Immersive Solid Deep Black Background */}
      <div className="absolute inset-0 z-0 bg-black pointer-events-none"></div>

      {/* Header */}
      <header className="relative z-20 pt-12 px-6">
        <button
          onClick={handleMinimize}
          className="size-11 rounded-full bg-white/5 border border-white/10 flex items-center justify-center backdrop-blur-xl active:scale-90 transition-all"
        >
          <span className="material-symbols-outlined text-white/40 text-[20px]">close_fullscreen</span>
        </button>
      </header>

      {/* Main Content Area */}
      <main className="relative z-20 flex-1 flex flex-col items-center pt-10">
        {/* Avatar Container */}
        <div className="relative z-10 mb-8 p-1 rounded-full border border-white/5 bg-black/40 shadow-2xl">
          <div className="size-40 rounded-full bg-center bg-cover border-2 border-white/10 overflow-hidden" style={{ backgroundImage: `url("${contact.avatar}")` }}></div>
        </div>

        <h1 className="text-3xl font-black text-white tracking-tight uppercase mb-3">{contact.name}</h1>

        {/* Status Dot */}
        <div className="flex items-center justify-center mb-6">
          <span className="size-2 rounded-full bg-primary shadow-[0_0_15px_var(--color-primary)] animate-pulse"></span>
        </div>

        <p className="text-white/40 font-mono text-2xl tabular-nums tracking-[0.3em] mb-12">{formatTime(seconds)}</p>

        {/* Options Section */}
        <div className="flex flex-col items-center w-full px-6 gap-12 mt-auto pb-16">
          <div className="grid grid-cols-3 gap-8 w-full max-w-[320px]">
            <button onClick={toggleMute} className="flex flex-col items-center gap-3 group">
              <div className={`size-16 rounded-full flex items-center justify-center transition-all duration-300 border ${activeCall.isMuted ? 'bg-white text-black border-white' : 'bg-white/5 border-white/10 text-white active:bg-white/10'}`}>
                <span className="material-symbols-outlined text-[28px]">{activeCall.isMuted ? 'mic_off' : 'mic'}</span>
              </div>
              <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">MUTE</span>
            </button>

            <button className="flex flex-col items-center gap-3 group">
              <div className="size-16 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white active:bg-white/10 transition-all">
                <span className="material-symbols-outlined text-[28px]">grid_view</span>
              </div>
              <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">MATRIX</span>
            </button>

            <button className="flex flex-col items-center gap-3 group">
              <div className="size-16 rounded-full bg-white/5 border border-white/10 text-white flex items-center justify-center active:bg-white/10 transition-all">
                <span className="material-symbols-outlined text-[28px]">volume_up</span>
              </div>
              <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">SPEAKER</span>
            </button>
          </div>

          <button
            onClick={handleEndCall}
            className="size-20 rounded-full bg-danger/90 flex items-center justify-center shadow-[0_0_50px_rgba(239,68,68,0.4)] active:scale-90 transition-all border-4 border-black/20"
          >
            <span className="material-symbols-outlined text-white text-4xl fill-1">call_end</span>
          </button>
        </div>
      </main>
    </div>
  );
};

export default AudioCallScreen;
