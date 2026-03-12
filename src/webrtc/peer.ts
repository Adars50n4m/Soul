const ICE_SERVERS: RTCIceServer[] = [
    // STUN (fast, direct connection attempt first)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },

    // TURN (required for 4G/5G and strict NAT — relays media when direct connection fails)
    {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject',
    },
    {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
    },
    {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject',
    },
    {
        urls: 'turns:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
    },
];

export const createPeer = (
    onIceCandidate: (candidate: RTCIceCandidate) => void,
    onTrack: (stream: MediaStream) => void,
    onConnectionStateChange?: (state: RTCPeerConnectionState) => void
): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            onIceCandidate(event.candidate);
        }
    };

    pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
            onTrack(event.streams[0]);
        }
    };

    pc.onconnectionstatechange = () => {
        onConnectionStateChange?.(pc.connectionState);
    };

    return pc;
};

export const createOffer = async (pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
};

export const createAnswer = async (pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> => {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer;
};

export const setRemoteDescription = async (
    pc: RTCPeerConnection,
    desc: RTCSessionDescriptionInit
): Promise<void> => {
    await pc.setRemoteDescription(new RTCSessionDescription(desc));
};

export const addIceCandidate = async (
    pc: RTCPeerConnection,
    candidate: RTCIceCandidateInit
): Promise<void> => {
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.warn('[Peer] Failed to add ICE candidate:', err);
    }
};

export const attachLocalStream = (pc: RTCPeerConnection, stream: MediaStream): void => {
    stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
    });
};

export const closePeer = (pc: RTCPeerConnection | null): void => {
    if (!pc) return;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
};

export const getUserMedia = async (callType: 'audio' | 'video'): Promise<MediaStream> => {
    const constraints: MediaStreamConstraints = {
        audio: true,
        video: callType === 'video' ? { facingMode: 'user', width: 640, height: 480 } : false,
    };
    return navigator.mediaDevices.getUserMedia(constraints);
};

export const stopStream = (stream: MediaStream | null): void => {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
};
