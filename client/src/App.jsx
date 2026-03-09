import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import GhostMascot, { MOODS } from './components/GhostMascot.jsx';
import {
  generateKeyPair, exportKeyPair, importKeyPair,
  encryptMessage, decryptMessage, encryptBinary, decryptBinary,
  getKeyFingerprint, shouldRotateKeys, solvePoW,
} from './crypto/index.js';
import {
  saveMessage, getMessages, deleteMessage, markMessageSeen,
  purgeExpiredMessages, saveVoiceMessage, getVoiceMessages,
  saveContact, getContacts, getContact,
  saveKeys, getKeys, getSetting, setSetting,
  getLoginHistory, panicWipe, logLogin,
} from './db/index.js';
import {
  getPoWChallenge, register, login, logout as apiLogout,
  setPublicKey, getPublicKey, rotateKeys, setDecoyPassword,
  getFriends, addFriend, acceptFriend, removeFriend, blockUser,
  getPendingRequests, getWorldMessages, sendWorldMessage,
  drainInbox, sendMessage, sendVoiceMessage as apiSendVoice,
  recallMessage as apiRecall, setTokens, clearTokens, copyWithAutoClear,
  setDisplayName, getMe,
} from './api.js';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const LOCK_TIMEOUT = 5 * 60 * 1000;

// ── Client-side login rate limiter ────────────────────────────────────────────
const loginAttempts = { count: 0, lockedUntil: null };

function checkLoginRateLimit() {
  const now = Date.now();
  if (loginAttempts.lockedUntil && now < loginAttempts.lockedUntil) {
    const secs = Math.ceil((loginAttempts.lockedUntil - now) / 1000);
    throw new Error(`Too many attempts. Try again in ${secs}s`);
  }
  if (loginAttempts.lockedUntil && now >= loginAttempts.lockedUntil) {
    loginAttempts.count = 0;
    loginAttempts.lockedUntil = null;
  }
}

function recordLoginFailure() {
  loginAttempts.count++;
  if (loginAttempts.count >= 5) {
    loginAttempts.lockedUntil = Date.now() + 60 * 1000;
  }
}

function recordLoginSuccess() {
  loginAttempts.count = 0;
  loginAttempts.lockedUntil = null;
}

export default function App() {
  const [screen, setScreen] = useState('loading');
  const [accountCode, setAccountCode] = useState(null);
  const [friendCode, setFriendCode] = useState(null);
  const [keys, setKeys] = useState(null);
  const [friends, setFriends] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [worldMessages, setWorldMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [selfDestructTime, setSelfDestructTime] = useState(null);
  const [ghostMode, setGhostMode] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [mascotMood, setMascotMood] = useState(MOODS.IDLE);
  const [activeTab, setActiveTab] = useState('chats');
  const [pendingRequests, setPendingRequests] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [notification, setNotification] = useState(null);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [minimalMode, setMinimalMode] = useState(false);
  const [fingerprintTarget, setFingerprintTarget] = useState(null);
  const [loginHistory, setLoginHistory] = useState([]);
  const [powSolving, setPowSolving] = useState(false);
  const [isDecoySession, setIsDecoySession] = useState(false);
  const [displayName, setDisplayName_] = useState('');
  const [showNamePicker, setShowNamePicker] = useState(false);

  const socketRef = useRef(null);
  const lockTimerRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const typingTimerRef = useRef(null);
  const storedPasswordRef = useRef(null);
  const recallTimersRef = useRef(new Map());

  // ── FIX: Refs to avoid stale closure in socket callbacks ─────────────────
  const activeChatRef = useRef(null);
  const keysRef = useRef(null);
  const accountCodeRef = useRef(null);

  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);
  useEffect(() => { keysRef.current = keys; }, [keys]);
  useEffect(() => { accountCodeRef.current = accountCode; }, [accountCode]);

  // ── Startup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const savedCode = await getSetting('accountCode');
      const savedFriendCode = await getSetting('friendCode');
      const savedKeys = await getKeys();
      if (savedCode && savedKeys) {
        setAccountCode(savedCode);
        accountCodeRef.current = savedCode;
        setFriendCode(savedFriendCode);
        setKeys(importKeyPair(savedKeys));
        // Load saved display name
        const savedName = await getSetting('displayName');
        if (savedName) setDisplayName_(savedName);
        setScreen('login');
      } else {
        setScreen('welcome');
      }
      await purgeExpiredMessages();
      const mm = await getSetting('minimalMode', false);
      setMinimalMode(mm);
    })();
  }, []);

  // ── Notification helper ────────────────────────────────────────────────────
  const showNotification = useCallback((message, type = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  }, []);

  // ── Inactivity lock ────────────────────────────────────────────────────────
  const resetLockTimer = useCallback(() => {
    clearTimeout(lockTimerRef.current);
    lockTimerRef.current = setTimeout(() => {
      setSessionLocked(true);
      setMascotMood(MOODS.LOCKED);
      socketRef.current?.disconnect();
    }, LOCK_TIMEOUT);
  }, []);

  useEffect(() => {
    if (screen !== 'app') return;
    const events = ['mousedown', 'keydown', 'touchstart'];
    events.forEach(e => window.addEventListener(e, resetLockTimer));
    resetLockTimer();
    return () => events.forEach(e => window.removeEventListener(e, resetLockTimer));
  }, [screen, resetLockTimer]);

  // ── Incoming message (uses refs — no stale closure) ───────────────────────
  const handleIncomingMessage = useCallback(async (envelope) => {
    const currentKeys = keysRef.current;
    const currentActiveChat = activeChatRef.current;
    if (!currentKeys || !envelope.payload) return;

    if (envelope.type === 'recall') {
      setMessages(prev => prev.filter(m => m.id !== envelope.targetId));
      await deleteMessage(envelope.targetId);
      return;
    }

    const decrypted = decryptMessage(envelope.payload, currentKeys.secretKey);
    if (!decrypted) return;

    const msg = {
      id: envelope.id,
      from: envelope.from,
      displayName: envelope.displayName || null,
      content: typeof decrypted === 'string' ? decrypted : decrypted.content,
      selfDestructSeconds: envelope.selfDestructSeconds,
      selfDestructAt: envelope.selfDestructSeconds
        ? Date.now() + envelope.selfDestructSeconds * 1000 : null,
      burnOnRead: decrypted.burnOnRead || false,
      ts: envelope.ts || Date.now(),
      status: 'received',
      conversationId: envelope.from,
    };

    await saveMessage(msg);
    if (currentActiveChat?.accountCode === envelope.from) {
      setMessages(prev => [...prev, msg]);
    }
    setMascotMood(MOODS.EXCITED);
    setTimeout(() => setMascotMood(MOODS.IDLE), 2000);
    socketRef.current?.emit('message_delivered', { messageId: envelope.id, senderCode: envelope.from });

    if (msg.selfDestructSeconds) {
      recallTimersRef.current.set(msg.id, setTimeout(async () => {
        await deleteMessage(msg.id);
        setMessages(prev => prev.filter(m => m.id !== msg.id));
      }, msg.selfDestructSeconds * 1000));
    }
  }, []); // intentionally empty — uses refs only

  const handleIncomingVoice = useCallback(async (envelope) => {
    const currentKeys = keysRef.current;
    const currentActiveChat = activeChatRef.current;
    if (!currentKeys || !envelope.payload) return;
    const decrypted = decryptBinary(envelope.payload, currentKeys.secretKey);
    if (!decrypted) return;
    const blob = new Blob([decrypted], { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const voiceMsg = {
      id: envelope.id, from: envelope.from, type: 'voice',
      audioUrl: url, duration: envelope.duration, ts: envelope.ts,
      conversationId: envelope.from,
    };
    await saveVoiceMessage(voiceMsg);
    if (currentActiveChat?.accountCode === envelope.from) {
      setMessages(prev => [...prev, voiceMsg]);
    }
  }, []); // intentionally empty — uses refs only

  // ── Connect socket ─────────────────────────────────────────────────────────
  const connectSocket = useCallback((token) => {
    if (socketRef.current?.connected) socketRef.current.disconnect();
    const socket = io(API_URL, { auth: { token }, transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      if (ghostMode) socket.emit('set_ghost_mode', true);
      drainInbox().then(({ messages: msgs }) => {
        msgs.forEach(msg => handleIncomingMessage(msg));
      });
    });

    socket.on('private_message', handleIncomingMessage);
    socket.on('voice_message', handleIncomingVoice);
    socket.on('world_message', (msg) => {
      setWorldMessages(prev => [...prev.slice(-99), msg]);
    });
    socket.on('user_online', ({ accountCode: ac }) => {
      setOnlineUsers(prev => new Set([...prev, ac]));
    });
    socket.on('user_offline', ({ accountCode: ac }) => {
      setOnlineUsers(prev => { const s = new Set(prev); s.delete(ac); return s; });
    });
    socket.on('typing_start', ({ from }) => {
      if (activeChatRef.current?.accountCode === from) setMascotMood(MOODS.TYPING);
    });
    socket.on('typing_stop', () => setMascotMood(MOODS.IDLE));
    socket.on('message_recalled', ({ messageId }) => {
      setMessages(prev => prev.filter(m => m.id !== messageId));
      deleteMessage(messageId);
    });
    socket.on('friend_request', ({ from }) => {
      setPendingRequests(prev => {
        if (prev.find(r => r.requester_code === from)) return prev;
        return [{ requester_code: from, created_at: new Date().toISOString() }, ...prev];
      });
      showNotification('New friend request received', 'info');
    });
    socket.on('delivery_receipt', ({ messageId, status }) => {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status } : m));
    });

    return socket;
  }, [handleIncomingMessage, handleIncomingVoice, showNotification, ghostMode]);

  // ── Registration ───────────────────────────────────────────────────────────
  const handleRegister = async (password) => {
    setPowSolving(true);
    setMascotMood(MOODS.TYPING);
    try {
      const challenge = await getPoWChallenge();
      showNotification('Solving security puzzle...', 'info');
      const solution = await solvePoW(challenge.challenge, challenge.difficulty);
      const result = await register(password, challenge.challenge, solution.nonce, challenge.timestamp);

      const kp = generateKeyPair();
      const exported = exportKeyPair(kp);

      await saveKeys(exported);
      await setSetting('accountCode', result.accountCode);
      await setSetting('friendCode', result.friendCode);
      await logLogin();

      setTokens(result.accessToken, result.refreshToken);
      await setSetting('accessToken', result.accessToken);
      await setPublicKey(exported.publicKey);

      setAccountCode(result.accountCode);
      accountCodeRef.current = result.accountCode;
      setFriendCode(result.friendCode);
      setKeys(kp);
      keysRef.current = kp;
      storedPasswordRef.current = password;

      connectSocket(result.accessToken);
      setScreen('app');
      setMascotMood(MOODS.HAPPY);
      setShowNamePicker(true); // prompt new user to pick a name
      if (result.warning) showNotification(result.warning, 'warning');
    } catch (err) {
      showNotification(err.message, 'error');
      setMascotMood(MOODS.ALERT);
    } finally {
      setPowSolving(false);
    }
  };

  // ── Login ──────────────────────────────────────────────────────────────────
  const handleLogin = async (code, password) => {
    setMascotMood(MOODS.TYPING);
    try {
      checkLoginRateLimit();
      const result = await login(code, password);
      recordLoginSuccess();

      setTokens(result.accessToken, result.refreshToken);
      await setSetting('accessToken', result.accessToken);

      const savedKeys = await getKeys();
      if (!savedKeys) throw new Error('Keys not found. This may not be your device.');

      const kp = importKeyPair(savedKeys);
      setKeys(kp);
      keysRef.current = kp;
      setAccountCode(result.accountCode || code);
      accountCodeRef.current = result.accountCode || code;
      const sc = await getSetting('friendCode');
      setFriendCode(sc);
      storedPasswordRef.current = password;

      await logLogin();
      const { requests } = await getPendingRequests();
      setPendingRequests(requests);
      const history = await getLoginHistory();
      setLoginHistory(history);

      // Load display name
      try {
        const me = await getMe();
        if (me.display_name) {
          setDisplayName_(me.display_name);
          await setSetting('displayName', me.display_name);
        }
      } catch {}

      if (result.decoy) {
        setIsDecoySession(true);
        setScreen('app');
        setMascotMood(MOODS.IDLE);
        return;
      }

      connectSocket(result.accessToken);
      setScreen('app');
      setMascotMood(MOODS.HAPPY);

      const { friends: fl } = await getFriends();
      setFriends(fl);
      const { messages: wm } = await getWorldMessages();
      setWorldMessages(wm);
      const savedKeysData = await getKeys();
      if (shouldRotateKeys(savedKeysData?.savedAt)) handleKeyRotation(kp);

    } catch (err) {
      if (err.message.includes('Try again in')) {
        showNotification(err.message, 'error');
      } else {
        recordLoginFailure();
        const remaining = 5 - loginAttempts.count;
        if (loginAttempts.lockedUntil) {
          showNotification('Too many failed attempts. Locked for 60 seconds.', 'error');
        } else if (remaining > 0) {
          showNotification(`Invalid credentials. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before lockout.`, 'error');
        } else {
          showNotification(err.message, 'error');
        }
      }
      setMascotMood(MOODS.ALERT);
    }
  };

  // ── Unlock ─────────────────────────────────────────────────────────────────
  const handleUnlock = async (password) => {
    if (password === storedPasswordRef.current) {
      setSessionLocked(false);
      setMascotMood(MOODS.HAPPY);
      const savedToken = await getSetting('accessToken');
      if (savedToken) connectSocket(savedToken);
    } else {
      showNotification('Wrong password', 'error');
      setMascotMood(MOODS.ALERT);
    }
  };

  // ── Key rotation ───────────────────────────────────────────────────────────
  const handleKeyRotation = async (currentKeys) => {
    const newKp = generateKeyPair();
    const exported = exportKeyPair(newKp);
    await saveKeys(exported);
    await rotateKeys(exported.publicKey);
    setKeys(newKp);
    keysRef.current = newKp;
    showNotification('Encryption keys rotated automatically', 'info');
  };

  // ── Send message (uses refs — no stale closure) ───────────────────────────
  const handleSendMessage = async () => {
    const currentActiveChat = activeChatRef.current;
    const currentKeys = keysRef.current;
    const currentAccountCode = accountCodeRef.current;
    if (!inputText.trim() || !currentActiveChat || !currentKeys) return;

    const contactPubKey = await getPublicKey(currentActiveChat.accountCode);
    if (!contactPubKey?.publicKey) { showNotification('Could not get recipient public key', 'error'); return; }

    const encrypted = encryptMessage(
      { content: inputText.trim(), burnOnRead: false },
      contactPubKey.publicKey, currentKeys.secretKey
    );
    const msgId = crypto.randomUUID();
    const msg = {
      id: msgId, from: currentAccountCode, content: inputText.trim(),
      selfDestructSeconds: selfDestructTime,
      selfDestructAt: selfDestructTime ? Date.now() + selfDestructTime * 1000 : null,
      ts: Date.now(), status: 'sent', conversationId: currentActiveChat.accountCode,
    };

    await saveMessage(msg);
    setMessages(prev => [...prev, msg]);
    setInputText('');

    recallTimersRef.current.set(msgId, null);
    setTimeout(() => recallTimersRef.current.delete(msgId), 10000);

    try {
      socketRef.current?.emit('private_message', {
        id: msgId, recipientCode: currentActiveChat.accountCode,
        payload: encrypted, selfDestructSeconds: selfDestructTime,
      });
      await sendMessage(currentActiveChat.accountCode, encrypted, selfDestructTime);
    } catch (err) {
      showNotification('Failed to send message', 'error');
    }

    setMascotMood(MOODS.HAPPY);
    setTimeout(() => setMascotMood(MOODS.IDLE), 1000);
  };

  // ── Recall ─────────────────────────────────────────────────────────────────
  const handleRecallMessage = async (msgId) => {
    if (!recallTimersRef.current.has(msgId)) {
      showNotification('Recall window expired (10 seconds)', 'error'); return;
    }
    const currentActiveChat = activeChatRef.current;
    socketRef.current?.emit('recall_message', { messageId: msgId, recipientCode: currentActiveChat.accountCode });
    await apiRecall(msgId, currentActiveChat.accountCode);
    await deleteMessage(msgId);
    setMessages(prev => prev.filter(m => m.id !== msgId));
  };

  // ── Voice recording ────────────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach(t => t.stop());
        await sendVoiceMsgBlob(blob);
      };
      recorder.start();
      setIsRecording(true);
      setMascotMood(MOODS.EXCITED);
    } catch (err) {
      showNotification('Microphone access denied', 'error');
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
    setMascotMood(MOODS.IDLE);
  };

  const sendVoiceMsgBlob = async (blob) => {
    const currentActiveChat = activeChatRef.current;
    const currentKeys = keysRef.current;
    if (!currentActiveChat || !currentKeys) return;
    const contactPubKey = await getPublicKey(currentActiveChat.accountCode);
    if (!contactPubKey?.publicKey) return;
    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const encrypted = encryptBinary(uint8, contactPubKey.publicKey);
    socketRef.current?.emit('voice_message', {
      id: crypto.randomUUID(), recipientCode: currentActiveChat.accountCode, payload: encrypted, duration: 0,
    });
    await apiSendVoice(currentActiveChat.accountCode, encrypted, 0);
  };

  // ── Typing indicator ───────────────────────────────────────────────────────
  const handleInputChange = (e) => {
    setInputText(e.target.value);
    setMascotMood(MOODS.TYPING);
    socketRef.current?.emit('typing_start', { recipientCode: activeChatRef.current?.accountCode });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      setMascotMood(MOODS.IDLE);
      socketRef.current?.emit('typing_stop', { recipientCode: activeChatRef.current?.accountCode });
    }, 1500);
  };

  // ── Friend requests ────────────────────────────────────────────────────────
  const handleAcceptRequest = async (requesterCode) => {
    try {
      await acceptFriend(requesterCode);
      setPendingRequests(prev => prev.filter(r => r.requester_code !== requesterCode));
      const { friends: fl } = await getFriends();
      setFriends(fl);
      showNotification('Friend request accepted!', 'info');
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const handleRejectRequest = async (requesterCode) => {
    try {
      await removeFriend(requesterCode);
      setPendingRequests(prev => prev.filter(r => r.requester_code !== requesterCode));
      showNotification('Request declined', 'info');
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  // ── Open chat ──────────────────────────────────────────────────────────────
  const openChat = async (friend) => {
    if (!friend) { setActiveChat(null); activeChatRef.current = null; setMessages([]); return; }
    setActiveChat(friend);
    activeChatRef.current = friend;
    setActiveTab('chats');
    const msgs = await getMessages(friend.accountCode);
    setMessages(msgs);
    socketRef.current?.emit('join_group', friend.accountCode);
    setMascotMood(MOODS.HAPPY);
  };

  // ── Set display name ───────────────────────────────────────────────────────
  const handleSetDisplayName = async (name) => {
    try {
      await setDisplayName(name);
      setDisplayName_(name);
      await setSetting('displayName', name);
      socketRef.current?.emit('update_display_name', name);
      setShowNamePicker(false);
      showNotification(`Name set to "${name}"`, 'info');
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  // ── Panic / logout ─────────────────────────────────────────────────────────
  const handlePanic = async () => {
    socketRef.current?.emit('panic');
    socketRef.current?.disconnect();
    clearTokens();
    await panicWipe();
    window.location.reload();
  };

  const showFingerprint = async (code) => {
    const { publicKey } = await getPublicKey(code);
    const fp = await getKeyFingerprint(publicKey);
    setFingerprintTarget({ code, fingerprint: fp });
  };

  const handleLogout = async () => {
    try { await apiLogout(); } catch {}
    clearTokens();
    await setSetting('accessToken', null);
    socketRef.current?.disconnect();
    setScreen('login');
    setMascotMood(MOODS.IDLE);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (screen === 'loading') return <LoadingScreen />;
  if (sessionLocked) return <LockScreen onUnlock={handleUnlock} mascotMood={mascotMood} />;
  if (screen === 'welcome') return <WelcomeScreen onContinue={() => setScreen('register')} onLogin={() => setScreen('login')} />;
  if (screen === 'register') return <RegisterScreen onRegister={handleRegister} onSwitchToLogin={() => setScreen('login')} mascotMood={powSolving ? MOODS.TYPING : mascotMood} solving={powSolving} />;
  if (screen === 'login') return <LoginScreen onLogin={handleLogin} onSwitchToRegister={() => setScreen('welcome')} mascotMood={mascotMood} savedAccountCode={accountCode} />;

  if (screen === 'app') {
    return (
      <ChatApp
        accountCode={accountCode}
        friendCode={friendCode}
        friends={friends}
        setFriends={setFriends}
        activeChat={activeChat}
        messages={messages}
        worldMessages={worldMessages}
        inputText={inputText}
        onInputChange={handleInputChange}
        onSend={handleSendMessage}
        onOpenChat={openChat}
        onRecall={handleRecallMessage}
        selfDestructTime={selfDestructTime}
        onSelfDestructChange={setSelfDestructTime}
        isRecording={isRecording}
        onStartRecord={startRecording}
        onStopRecord={stopRecording}
        ghostMode={ghostMode}
        onToggleGhostMode={(v) => { setGhostMode(v); socketRef.current?.emit('set_ghost_mode', v); }}
        onlineUsers={onlineUsers}
        mascotMood={mascotMood}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        pendingRequests={pendingRequests}
        onPanic={handlePanic}
        onLogout={handleLogout}
        onShowFingerprint={showFingerprint}
        fingerprintTarget={fingerprintTarget}
        onCloseFP={() => setFingerprintTarget(null)}
        onCopyCode={() => copyWithAutoClear(friendCode)}
        minimalMode={minimalMode}
        onToggleMinimal={() => setMinimalMode(v => !v)}
        isDecoySession={isDecoySession}
        onAddFriend={async (code) => {
          if (!code.trim()) { showNotification('Enter a friend code first', 'error'); return; }
          try {
            await addFriend(code.trim());
            const { friends: fl } = await getFriends();
            setFriends(fl);
            showNotification('Friend request sent!', 'info');
          } catch (err) {
            showNotification(err.message || 'Failed to send friend request', 'error');
          }
        }}
        onAcceptRequest={handleAcceptRequest}
        onRejectRequest={handleRejectRequest}
        notification={notification}
        loginHistory={loginHistory}
        keys={keys}
        displayName={displayName}
        showNamePicker={showNamePicker}
        onSetDisplayName={handleSetDisplayName}
        onDismissNamePicker={() => setShowNamePicker(false)}
        onSendWorld={async (content) => {
          try {
            // Optimistic update — tag as mine so it shows on right side immediately
            const optimistic = {
              id: crypto.randomUUID(),
              content,
              display_name: displayName || 'Ghost',
              ts: Date.now(),
              isMine: true,
            };
            setWorldMessages(prev => [...prev.slice(-99), optimistic]);
            await sendWorldMessage(content);
          } catch (err) { showNotification(err.message, 'error'); }
        }}
      />
    );
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Welcome Screen
// ────────────────────────────────────────────────────────────────────────────

const WELCOME_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=DM+Sans:wght@400;500;700&display=swap');
  .wc-page { min-height:100vh; background:#0a0a0f; display:flex; align-items:flex-start; justify-content:center; padding:0 1rem 3rem; overflow-y:auto; }
  .wc-inner { width:100%; max-width:460px; padding-top:3rem; display:flex; flex-direction:column; align-items:center; animation:wc-rise 0.55s cubic-bezier(0.16,1,0.3,1) both; }
  @keyframes wc-rise { from{opacity:0;transform:translateY(28px)} to{opacity:1;transform:translateY(0)} }
  .wc-ghost { margin-bottom:1.4rem; filter:drop-shadow(0 0 32px rgba(130,100,255,0.45)); animation:wc-float 3.5s ease-in-out infinite; }
  @keyframes wc-float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-9px)} }
  .wc-logo { font-family:'Share Tech Mono',monospace; font-size:1.9rem; letter-spacing:0.28em; color:#fff; margin:0 0 0.25rem; text-shadow:0 0 40px rgba(130,100,255,0.6); }
  .wc-tagline { font-family:'DM Sans',sans-serif; font-size:0.82rem; color:rgba(255,255,255,0.35); letter-spacing:0.07em; margin:0 0 2rem; }
  .wc-features { width:100%; display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:1.8rem; }
  .wc-feature-card { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.07); border-radius:12px; padding:14px 14px 12px; display:flex; flex-direction:column; gap:5px; }
  .wc-feature-icon { font-size:1.3rem; }
  .wc-feature-name { font-family:'DM Sans',sans-serif; font-size:0.78rem; font-weight:700; color:rgba(220,215,255,0.9); }
  .wc-feature-desc { font-family:'DM Sans',sans-serif; font-size:0.71rem; color:rgba(255,255,255,0.3); line-height:1.5; }
  .wc-divider { width:100%; height:1px; background:rgba(255,255,255,0.07); margin:0.2rem 0 1.6rem; }
  .wc-desc { font-family:'DM Sans',sans-serif; font-size:0.82rem; line-height:1.75; color:rgba(255,255,255,0.38); text-align:center; margin-bottom:1.8rem; max-width:380px; }
  .wc-warn-badge { display:flex; align-items:center; gap:10px; padding:10px 18px; background:rgba(255,70,70,0.08); border:1px solid rgba(255,70,70,0.2); border-radius:100px; margin-bottom:1.6rem; font-family:'DM Sans',sans-serif; font-size:0.78rem; font-weight:700; color:rgba(255,150,150,0.9); letter-spacing:0.05em; }
  .wc-warn-title { font-family:'Share Tech Mono',monospace; font-size:1.2rem; letter-spacing:0.08em; color:#fff; margin:0 0 0.4rem; text-align:center; }
  .wc-warn-sub { font-family:'DM Sans',sans-serif; font-size:0.8rem; color:rgba(255,120,120,0.6); margin:0 0 1.8rem; text-align:center; }
  .wc-warn-list { width:100%; display:flex; flex-direction:column; gap:10px; margin-bottom:1.8rem; }
  .wc-warn-item { display:flex; gap:14px; align-items:flex-start; padding:14px 16px; background:rgba(255,60,60,0.05); border:1px solid rgba(255,60,60,0.12); border-radius:12px; }
  .wc-warn-emoji { font-size:1.3rem; flex-shrink:0; margin-top:1px; }
  .wc-warn-item-title { font-family:'DM Sans',sans-serif; font-size:0.82rem; font-weight:700; color:rgba(255,190,190,0.9); margin-bottom:4px; }
  .wc-warn-item-body { font-family:'DM Sans',sans-serif; font-size:0.75rem; line-height:1.6; color:rgba(255,255,255,0.35); }
  .wc-btn-primary { width:100%; padding:0.9rem; background:linear-gradient(135deg,#6c3de8,#9b5cf6); border:none; border-radius:12px; color:#fff; font-family:'DM Sans',sans-serif; font-weight:700; font-size:0.88rem; letter-spacing:0.03em; cursor:pointer; box-shadow:0 4px 28px rgba(108,61,232,0.45); transition:transform 0.15s,box-shadow 0.15s; margin-bottom:0.65rem; }
  .wc-btn-primary:hover { transform:translateY(-1px); box-shadow:0 6px 36px rgba(108,61,232,0.6); }
  .wc-btn-ghost { width:100%; padding:0.8rem; background:transparent; border:1px solid rgba(255,255,255,0.1); border-radius:12px; color:rgba(255,255,255,0.38); font-family:'DM Sans',sans-serif; font-size:0.82rem; cursor:pointer; transition:border-color 0.2s,color 0.2s; }
  .wc-btn-ghost:hover { border-color:rgba(255,255,255,0.22); color:rgba(255,255,255,0.65); }
  .wc-back-link { background:none; border:none; color:rgba(255,255,255,0.25); font-family:'DM Sans',sans-serif; font-size:0.78rem; cursor:pointer; margin-top:0.8rem; text-decoration:underline; text-underline-offset:3px; }
  .wc-back-link:hover { color:rgba(255,255,255,0.5); }
`;

function WelcomeScreen({ onContinue, onLogin }) {
  const [step, setStep] = useState(0);
  const features = [
    { icon: '🔒', name: 'End-to-end encrypted', desc: 'Messages encrypted on your device. Nobody else can read them.' },
    { icon: '👤', name: 'No identity required', desc: 'No username, email, or phone number. Ever.' },
    { icon: '💣', name: 'Self-destruct messages', desc: 'Set timers. Messages disappear automatically.' },
    { icon: '☠', name: 'Panic wipe', desc: 'One button instantly destroys all your data.' },
    { icon: '👻', name: 'Ghost mode', desc: 'Appear offline while still receiving messages.' },
    { icon: '💾', name: 'Local storage only', desc: 'Nothing uploaded to a server. Your device, your data.' },
  ];
  const warnings = [
    { icon: '🔑', title: 'No account recovery', body: 'Forget your account code or password and your account is gone forever. Write them down.' },
    { icon: '📱', title: 'Messages live on this device only', body: 'Clearing browser data or switching devices wipes everything permanently. No cloud backup.' },
    { icon: '👻', title: 'Ephemeral by design', body: 'Burned messages cannot be recovered by anyone, including us.' },
    { icon: '🚫', title: 'No moderation safety net', body: 'Ghost Chat is fully anonymous. Exercise caution with strangers.' },
  ];
  return (
    <>
      <style>{WELCOME_CSS}</style>
      <div className="wc-page">
        <div className="wc-inner">
          {step === 0 ? (
            <>
              <div className="wc-ghost"><GhostMascot mood={MOODS.IDLE} size={96} /></div>
              <h1 className="wc-logo">Ghost Chat</h1>
              <p className="wc-tagline">Anonymous. Ephemeral. Yours.</p>
              <div className="wc-features">
                {features.map((f, i) => (
                  <div className="wc-feature-card" key={i}>
                    <span className="wc-feature-icon">{f.icon}</span>
                    <span className="wc-feature-name">{f.name}</span>
                    <span className="wc-feature-desc">{f.desc}</span>
                  </div>
                ))}
              </div>
              <div className="wc-divider" />
              <p className="wc-desc">Ghost Chat is a zero-knowledge anonymous messenger. Your messages never touch our servers in readable form. Nothing is logged. Nothing is tracked.</p>
              <button className="wc-btn-primary" onClick={() => setStep(1)}>Continue — read the warnings →</button>
              <button className="wc-btn-ghost" onClick={onLogin}>I already have an account</button>
            </>
          ) : (
            <>
              <div className="wc-warn-badge">⚠️ Important — read before continuing</div>
              <h2 className="wc-warn-title">BEFORE YOU CONTINUE</h2>
              <p className="wc-warn-sub">These are not standard terms of service. Read them.</p>
              <div className="wc-warn-list">
                {warnings.map((w, i) => (
                  <div className="wc-warn-item" key={i}>
                    <span className="wc-warn-emoji">{w.icon}</span>
                    <div>
                      <div className="wc-warn-item-title">{w.title}</div>
                      <div className="wc-warn-item-body">{w.body}</div>
                    </div>
                  </div>
                ))}
              </div>
              <button className="wc-btn-primary" onClick={onContinue}>I understand — create my account</button>
              <button className="wc-back-link" onClick={() => setStep(0)}>← Go back</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Screens
// ────────────────────────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div className="screen center">
      <GhostMascot mood={MOODS.IDLE} size={80} />
      <p style={{ color: 'rgba(255,255,255,0.5)', marginTop: 16 }}>Initializing...</p>
    </div>
  );
}

function LockScreen({ onUnlock }) {
  const [pw, setPw] = useState('');
  return (
    <div className="screen center">
      <GhostMascot mood={MOODS.LOCKED} size={80} />
      <h2 style={{ color: '#aac', margin: '16px 0 8px' }}>Locked</h2>
      <p style={{ color: 'rgba(255,255,255,0.4)', marginBottom: 24, fontSize: 14 }}>Session locked due to inactivity</p>
      <input type="password" placeholder="Enter password to unlock" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && onUnlock(pw)} className="input" autoFocus />
      <button onClick={() => onUnlock(pw)} className="btn-primary" style={{ marginTop: 12 }}>Unlock</button>
    </div>
  );
}

function RegisterScreen({ onRegister, onSwitchToLogin, mascotMood, solving }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const handleSubmit = () => {
    if (pw.length < 8) { setErr('Password must be at least 8 characters'); return; }
    if (pw !== confirm) { setErr('Passwords do not match'); return; }
    setErr('');
    onRegister(pw);
  };
  return (
    <div className="screen center">
      <GhostMascot mood={mascotMood} size={100} />
      <h1 className="logo">Ghost Chat</h1>
      <p className="tagline">Anonymous. Ephemeral. Yours.</p>
      {solving ? (
        <div style={{ color: '#aac', fontSize: 14, margin: '16px 0' }}>🔐 Solving security puzzle — this takes a few seconds...</div>
      ) : (
        <div className="form">
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginBottom: 16 }}>No username. No email. Just a password.</p>
          <input type="password" placeholder="Choose a password (min 8 chars)" value={pw} onChange={e => setPw(e.target.value)} className="input" />
          <input type="password" placeholder="Confirm password" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSubmit()} className="input" style={{ marginTop: 8 }} />
          {err && <p style={{ color: '#ff6b6b', fontSize: 13, marginTop: 8 }}>{err}</p>}
          <button onClick={handleSubmit} className="btn-primary" style={{ marginTop: 16 }}>Create Ghost Account</button>
          <button onClick={onSwitchToLogin} className="btn-ghost" style={{ marginTop: 8 }}>Already have an account</button>
        </div>
      )}
    </div>
  );
}

function LoginScreen({ onLogin, onSwitchToRegister, mascotMood, savedAccountCode }) {
  const [code, setCode] = useState(savedAccountCode || '');
  const [pw, setPw] = useState('');
  const [loading, setLoading] = useState(false);
  const [localErr, setLocalErr] = useState('');
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!loginAttempts.lockedUntil) return;
    const tick = () => {
      const left = Math.ceil((loginAttempts.lockedUntil - Date.now()) / 1000);
      if (left <= 0) { setCountdown(0); setLocalErr(''); loginAttempts.count = 0; loginAttempts.lockedUntil = null; return; }
      setCountdown(left);
      setLocalErr(`Too many attempts. Try again in ${left}s`);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [loginAttempts.lockedUntil]);

  const handleSubmit = async () => {
    if (loading || countdown > 0) return;
    if (!code.trim() || !pw) { setLocalErr('Enter your account code and password'); return; }
    setLocalErr('');
    setLoading(true);
    await onLogin(code.trim(), pw);
    if (loginAttempts.count > 0 && !loginAttempts.lockedUntil) {
      const remaining = 5 - loginAttempts.count;
      setLocalErr(`Invalid credentials. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
    }
    setLoading(false);
  };

  const isLocked = countdown > 0;

  return (
    <div className="screen center">
      <GhostMascot mood={isLocked ? MOODS.ALERT : mascotMood} size={100} />
      <h1 className="logo">Ghost Chat</h1>
      <div className="form">
        <input type="text" placeholder="Account code" value={code} onChange={e => setCode(e.target.value)} className="input" autoComplete="off" spellCheck={false} disabled={isLocked} />
        <input type="password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSubmit()} className="input" style={{ marginTop: 8 }} disabled={isLocked} />
        {localErr && (
          <div style={{ marginTop: 10, padding: '9px 13px', background: isLocked ? 'rgba(255,50,50,0.1)' : 'rgba(255,120,50,0.08)', border: `1px solid ${isLocked ? 'rgba(255,50,50,0.3)' : 'rgba(255,120,50,0.2)'}`, borderRadius: 9, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15 }}>{isLocked ? '🔒' : '⚠️'}</span>
            <span style={{ color: isLocked ? '#ff8080' : '#ffaa70', fontSize: 12, fontFamily: 'monospace' }}>{localErr}</span>
          </div>
        )}
        {loginAttempts.count > 0 && !isLocked && (
          <div style={{ display: 'flex', gap: 5, justifyContent: 'center', marginTop: 10 }}>
            {[...Array(5)].map((_, i) => (
              <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: i < loginAttempts.count ? '#ff5555' : 'rgba(255,255,255,0.12)', transition: 'background 0.3s', boxShadow: i < loginAttempts.count ? '0 0 6px rgba(255,50,50,0.6)' : 'none' }} />
            ))}
          </div>
        )}
        <button onClick={handleSubmit} className="btn-primary" style={{ marginTop: 16, opacity: isLocked || loading ? 0.5 : 1, cursor: isLocked || loading ? 'not-allowed' : 'pointer' }} disabled={isLocked || loading}>
          {loading ? 'Entering...' : isLocked ? `Locked — wait ${countdown}s` : 'Enter the Void'}
        </button>
        <button onClick={onSwitchToRegister} className="btn-ghost" style={{ marginTop: 8 }}>New ghost account</button>
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 16, textAlign: 'center' }}>
          ⚠️ Messages are stored on this device only. Clearing app data wipes your messages permanently.
        </p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Chat App
// ────────────────────────────────────────────────────────────────────────────

function ChatApp({
  accountCode, friendCode, friends, activeChat, messages, worldMessages,
  inputText, onInputChange, onSend, onOpenChat, onRecall,
  selfDestructTime, onSelfDestructChange,
  isRecording, onStartRecord, onStopRecord,
  ghostMode, onToggleGhostMode, onlineUsers,
  mascotMood, activeTab, onTabChange,
  pendingRequests, onPanic, onLogout,
  onShowFingerprint, fingerprintTarget, onCloseFP,
  onCopyCode, minimalMode, onToggleMinimal,
  isDecoySession, onAddFriend, onAcceptRequest, onRejectRequest,
  notification, loginHistory, keys, setFriends,
  onSendWorld, displayName, showNamePicker, onSetDisplayName, onDismissNamePicker,
}) {
  const [addFriendCode, setAddFriendCode] = useState('');
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showDecoySetup, setShowDecoySetup] = useState(false);
  const [decoyPw, setDecoyPw] = useState('');
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const DESTRUCT_OPTIONS = [
    { label: 'Off', value: null },
    { label: '30s', value: 30 },
    { label: '1m', value: 60 },
    { label: '5m', value: 300 },
    { label: '1h', value: 3600 },
    { label: '24h', value: 86400 },
  ];

  if (isDecoySession) {
    return (
      <div className="screen center">
        <GhostMascot mood={MOODS.IDLE} size={80} />
        <p style={{ color: 'rgba(255,255,255,0.4)', marginTop: 16 }}>No messages.</p>
        <button onClick={onLogout} className="btn-ghost" style={{ marginTop: 24 }}>Sign out</button>
      </div>
    );
  }

  return (
    <div className="app">
      {notification && (
        <div className={`notification notification-${notification.type}`}>{notification.message}</div>
      )}

      {showNamePicker && (
        <NamePickerModal
          current={displayName}
          onSave={onSetDisplayName}
          onSkip={onDismissNamePicker}
        />
      )}

      {fingerprintTarget && (
        <div className="modal-overlay" onClick={onCloseFP}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Key Fingerprint</h3>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>Compare with your contact out-of-band to verify no interception.</p>
            <code style={{ fontSize: 16, letterSpacing: 2, color: '#7af' }}>{fingerprintTarget.fingerprint}</code>
            <button onClick={onCloseFP} className="btn-ghost" style={{ marginTop: 16 }}>Close</button>
          </div>
        </div>
      )}

      <div className="sidebar">
        <div className="sidebar-header">
          <GhostMascot mood={mascotMood} size={48} />
          <div style={{ flex: 1, marginLeft: 12 }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>Your friend code</div>
            <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#aac', cursor: 'pointer', wordBreak: 'break-all' }} onClick={onCopyCode} title="Click to copy">
              {friendCode}
            </div>
          </div>
          <button onClick={onPanic} className="btn-panic" title="PANIC — wipe all data">☠</button>
        </div>

        <div className="tab-bar">
          {['chats', 'world', 'settings'].map(tab => (
            <button key={tab} onClick={() => onTabChange(tab)} className={`tab-btn ${activeTab === tab ? 'active' : ''}`} style={{ position: 'relative' }}>
              {tab === 'chats' ? '💬' : tab === 'world' ? '🌐' : '⚙️'}
              {tab === 'chats' && pendingRequests.length > 0 && (
                <span style={{ position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: '50%', background: '#f90', boxShadow: '0 0 6px rgba(255,150,0,0.8)' }} />
              )}
            </button>
          ))}
        </div>

        {activeTab === 'chats' && (
          <div className="friend-list">
            {pendingRequests.length > 0 && (
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 8, marginBottom: 4 }}>
                <div style={{ padding: '8px 12px 4px', fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,180,80,0.7)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Requests ({pendingRequests.length})
                </div>
                {pendingRequests.map(r => (
                  <div key={r.requester_code} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(255,160,40,0.05)', borderLeft: '2px solid rgba(255,160,40,0.3)', margin: '2px 0' }}>
                    <GhostMascot mood={MOODS.IDLE} size={28} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.requester_code.slice(0, 10)}...</div>
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>wants to connect</div>
                    </div>
                    <button title="Accept" onClick={() => onAcceptRequest(r.requester_code)} style={{ background: 'rgba(80,200,100,0.15)', border: '1px solid rgba(80,200,100,0.35)', borderRadius: 6, color: '#6f6', fontSize: 14, width: 28, height: 28, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</button>
                    <button title="Decline" onClick={() => onRejectRequest(r.requester_code)} style={{ background: 'rgba(200,60,60,0.12)', border: '1px solid rgba(200,60,60,0.3)', borderRadius: 6, color: '#f88', fontSize: 14, width: 28, height: 28, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <button className="btn-ghost" style={{ margin: '8px 12px', fontSize: 13 }} onClick={() => setShowAddFriend(v => !v)}>
              + Add friend
            </button>
            {showAddFriend && (
              <div style={{ padding: '0 12px 12px' }}>
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 6 }}>
                  Enter their <strong style={{ color: 'rgba(255,255,255,0.6)' }}>friend code</strong> — shown at the top of their sidebar
                </p>
                <input className="input" placeholder="e.g. gc_a1b2c3d4..." value={addFriendCode} onChange={e => setAddFriendCode(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { onAddFriend(addFriendCode); setAddFriendCode(''); setShowAddFriend(false); } }}
                  style={{ fontSize: 13 }} />
                <button className="btn-primary" style={{ marginTop: 8, width: '100%' }} onClick={() => { onAddFriend(addFriendCode); setAddFriendCode(''); setShowAddFriend(false); }}>
                  Send Request
                </button>
              </div>
            )}

            {friends.length > 0 && (
              <div style={{ padding: '4px 12px 2px', fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Friends ({friends.length})
              </div>
            )}
            {friends.map(f => (
              <div key={f.account_code} className={`friend-item ${activeChat?.accountCode === f.account_code ? 'active' : ''}`} onClick={() => onOpenChat({ accountCode: f.account_code })}>
                <div className="friend-avatar">
                  <GhostMascot mood={onlineUsers.has(f.account_code) ? MOODS.HAPPY : MOODS.SLEEPING} size={32} />
                </div>
                <div className="friend-info">
                  <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#ccd' }}>{f.account_code.slice(0, 10)}...</span>
                  <span style={{ fontSize: 11, color: onlineUsers.has(f.account_code) ? '#6f6' : 'rgba(255,255,255,0.3)' }}>
                    {onlineUsers.has(f.account_code) ? 'Online' : 'Offline'}
                  </span>
                </div>
                <button className="fp-btn" title="Verify key fingerprint" onClick={e => { e.stopPropagation(); onShowFingerprint(f.account_code); }}>🔑</button>
              </div>
            ))}
            {friends.length === 0 && pendingRequests.length === 0 && (
              <p style={{ color: 'rgba(255,255,255,0.25)', fontSize: 13, padding: '16px', textAlign: 'center' }}>
                No friends yet.<br />Share your friend code to connect.
              </p>
            )}
          </div>
        )}

        {activeTab === 'world' && (
          <div className="world-list">
            <p style={{ padding: 12, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>Anonymous world chat. No identity. 24h TTL.</p>
          </div>
        )}

        {activeTab === 'settings' && (
          <SettingsPanel
            ghostMode={ghostMode} onToggleGhostMode={onToggleGhostMode}
            minimalMode={minimalMode} onToggleMinimal={onToggleMinimal}
            onLogout={onLogout} accountCode={accountCode}
            showDecoySetup={showDecoySetup} onToggleDecoy={() => setShowDecoySetup(v => !v)}
            decoyPw={decoyPw} setDecoyPw={setDecoyPw}
            onSaveDecoy={async () => { await setDecoyPassword(decoyPw); setDecoyPw(''); setShowDecoySetup(false); }}
          />
        )}
      </div>

      <div className="main">
        {activeTab === 'world' ? (
          <WorldChat messages={worldMessages} onSend={onSendWorld} myDisplayName={displayName} />
        ) : activeTab === 'chats' && activeChat ? (
          <>
            <div className="chat-header">
              <GhostMascot mood={onlineUsers.has(activeChat.accountCode) ? MOODS.HAPPY : MOODS.IDLE} size={36} />
              <div style={{ flex: 1, marginLeft: 12 }}>
                <div style={{ fontFamily: 'monospace', color: '#ccd', fontSize: 14 }}>{activeChat.accountCode.slice(0, 12)}...</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>E2E Encrypted · Local storage only</div>
              </div>
              <button title="Close chat" onClick={() => onOpenChat(null)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.25)', fontSize: 18, cursor: 'pointer', padding: '4px 8px' }}>×</button>
            </div>
            <div className="messages">
              {messages.length === 0 && (
                <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.2)', fontSize: 13, padding: '40px 20px' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>👻</div>
                  No messages yet. Say hello!
                </div>
              )}
              {messages.map(msg => (
                <MessageBubble key={msg.id} msg={msg} isMine={msg.from === accountCode} onRecall={onRecall} />
              ))}
              <div ref={messagesEndRef} />
            </div>
            <div className="input-area">
              <div className="destruct-row">
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginRight: 8 }}>💣</span>
                {DESTRUCT_OPTIONS.map(opt => (
                  <button key={opt.label} className={`destruct-btn ${selfDestructTime === opt.value ? 'active' : ''}`} onClick={() => onSelfDestructChange(opt.value)}>{opt.label}</button>
                ))}
              </div>
              <div className="input-row">
                <input className="input msg-input" placeholder="Type a message..." value={inputText} onChange={onInputChange} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && onSend()} />
                <button className={`voice-btn ${isRecording ? 'recording' : ''}`} onMouseDown={onStartRecord} onMouseUp={onStopRecord} onTouchStart={onStartRecord} onTouchEnd={onStopRecord}>🎙</button>
                <button className="btn-primary send-btn" onClick={onSend}>↑</button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState hasFriends={friends.length > 0} hasPending={pendingRequests.length > 0} />
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg, isMine, onRecall }) {
  const [timeLeft, setTimeLeft] = useState(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!msg.selfDestructAt) return;
    const tick = () => {
      const left = msg.selfDestructAt - Date.now();
      if (left <= 0) { setVisible(false); return; }
      setTimeLeft(Math.ceil(left / 1000));
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [msg.selfDestructAt]);

  if (!visible) return null;
  if (msg.type === 'voice') {
    return (
      <div className={`message ${isMine ? 'mine' : 'theirs'}`}>
        <audio controls src={msg.audioUrl} style={{ maxWidth: 200 }} />
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', display: 'block', marginTop: 4 }}>Voice · {new Date(msg.ts).toLocaleTimeString()}</span>
      </div>
    );
  }

  return (
    <div className={`message ${isMine ? 'mine' : 'theirs'}`}>
      {!isMine && (
        <div style={{ fontSize: 10, color: '#9b8fc8', fontFamily: 'monospace', marginBottom: 3 }}>
          {msg.displayName || msg.from?.slice(0, 8) + '...'}
        </div>
      )}
      <div className="message-content">{msg.content}</div>
      <div className="message-meta">
        {timeLeft && <span style={{ color: '#f90', marginRight: 6 }}>💣 {timeLeft}s</span>}
        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>{new Date(msg.ts).toLocaleTimeString()}</span>
        {msg.status && (
          <span style={{ marginLeft: 6, fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
            {msg.status === 'seen' ? '✓✓' : msg.status === 'delivered' ? '✓✓' : '✓'}
          </span>
        )}
        {isMine && (
          <button onClick={() => onRecall(msg.id)} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'rgba(255,100,100,0.6)', cursor: 'pointer', fontSize: 11 }}>
            recall
          </button>
        )}
      </div>
    </div>
  );
}

function WorldChat({ messages, onSend, myDisplayName }) {
  const [input, setInput] = useState('');
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="chat-header">
        <span style={{ fontSize: 20 }}>🌐</span>
        <div style={{ marginLeft: 12 }}>
          <div style={{ color: '#ccd' }}>World Chat</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>Anonymous · 24h TTL · No identity</div>
        </div>
      </div>
      <div className="messages">
        {messages.map((msg, i) => {
          const isMine = !!msg.isMine;
          return (
            <div key={msg.id || i} className={`message ${isMine ? 'mine' : 'theirs'}`}>
              {!isMine && (
                <div style={{ fontSize: 10, color: '#9b8fc8', fontFamily: 'monospace', marginBottom: 3 }}>
                  👻 {msg.display_name || 'Ghost'}
                </div>
              )}
              <div className="message-content">{msg.content}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>
                {new Date(msg.ts || msg.created_at).toLocaleTimeString()}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="input-area">
        <div className="input-row">
          <input className="input msg-input" placeholder="Speak into the void..." value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { onSend(input); setInput(''); } }} maxLength={500} />
          <button className="btn-primary send-btn" onClick={() => { onSend(input); setInput(''); }}>↑</button>
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({ ghostMode, onToggleGhostMode, minimalMode, onToggleMinimal, onLogout, accountCode, showDecoySetup, onToggleDecoy, decoyPw, setDecoyPw, onSaveDecoy }) {
  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ color: '#aac', marginBottom: 16, fontSize: 14 }}>Settings</h3>
      <ToggleSetting label="👻 Ghost Mode" sublabel="Appear offline" value={ghostMode} onChange={onToggleGhostMode} />
      <ToggleSetting label="⬛ Minimal Mode" sublabel="Pure text UI" value={minimalMode} onChange={onToggleMinimal} />
      <div style={{ marginTop: 20 }}>
        <button className="btn-ghost" style={{ width: '100%', marginBottom: 8 }} onClick={onToggleDecoy}>🎭 Set Decoy Password</button>
        {showDecoySetup && (
          <div>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>Entering this password shows an empty fake chat.</p>
            <input className="input" type="password" placeholder="Decoy password" value={decoyPw} onChange={e => setDecoyPw(e.target.value)} />
            <button className="btn-primary" style={{ marginTop: 8, width: '100%' }} onClick={onSaveDecoy}>Save Decoy</button>
          </div>
        )}
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn-ghost" style={{ width: '100%', color: '#f66' }} onClick={onLogout}>Sign out</button>
      </div>
      <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', marginTop: 24, textAlign: 'center' }}>Account: {accountCode?.slice(0, 16)}...</p>
    </div>
  );
}

function ToggleSetting({ label, sublabel, value, onChange }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
      <div>
        <div style={{ color: '#ccd', fontSize: 14 }}>{label}</div>
        {sublabel && <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>{sublabel}</div>}
      </div>
      <div onClick={() => onChange(!value)} style={{ width: 42, height: 24, borderRadius: 12, background: value ? '#4a9' : 'rgba(255,255,255,0.15)', cursor: 'pointer', position: 'relative', transition: 'background 0.2s' }}>
        <div style={{ width: 18, height: 18, borderRadius: 9, background: 'white', position: 'absolute', top: 3, left: value ? 21 : 3, transition: 'left 0.2s' }} />
      </div>
    </div>
  );
}

function EmptyState({ hasFriends, hasPending }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)', padding: '2rem', textAlign: 'center' }}>
      <GhostMascot mood={MOODS.SLEEPING} size={80} />
      {hasPending ? (
        <>
          <p style={{ marginTop: 16, fontSize: 14, color: 'rgba(255,200,100,0.5)' }}>You have pending friend requests</p>
          <p style={{ marginTop: 4, fontSize: 12 }}>Check the 💬 chats tab to accept them</p>
        </>
      ) : hasFriends ? (
        <>
          <p style={{ marginTop: 16, fontSize: 14 }}>Select a conversation</p>
          <p style={{ marginTop: 4, fontSize: 12 }}>Choose a friend from the sidebar</p>
        </>
      ) : (
        <>
          <p style={{ marginTop: 16, fontSize: 14 }}>No conversations yet</p>
          <p style={{ marginTop: 4, fontSize: 12 }}>Add a friend using their friend code to get started</p>
        </>
      )}
    </div>
  );
}
