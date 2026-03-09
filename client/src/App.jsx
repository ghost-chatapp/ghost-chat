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
} from './api.js';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ── Inactivity lock (5 min) ───────────────────────────────────────────────────
const LOCK_TIMEOUT = 5 * 60 * 1000;

export default function App() {
  const [screen, setScreen] = useState('loading'); // loading | register | login | app | locked
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
  const [activeTab, setActiveTab] = useState('chats'); // chats | world | settings
  const [pendingRequests, setPendingRequests] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [notification, setNotification] = useState(null);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [lockPassword, setLockPassword] = useState('');
  const [minimalMode, setMinimalMode] = useState(false);
  const [fingerprintTarget, setFingerprintTarget] = useState(null);
  const [loginHistory, setLoginHistory] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [powSolving, setPowSolving] = useState(false);
  const [isDecoySession, setIsDecoySession] = useState(false);

  const socketRef = useRef(null);
  const lockTimerRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const typingTimerRef = useRef(null);
  const storedPasswordRef = useRef(null);
  const recallTimersRef = useRef(new Map());

  // ── Startup: load session ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const savedCode = await getSetting('accountCode');
      const savedFriendCode = await getSetting('friendCode');
      const savedKeys = await getKeys();

      if (savedCode && savedKeys) {
        setAccountCode(savedCode);
        setFriendCode(savedFriendCode);
        setKeys(importKeyPair(savedKeys));
        setScreen('login'); // require password even if session saved
      } else {
        setScreen('register');
      }

      // Purge expired messages on startup
      await purgeExpiredMessages();

      // Check minimal mode
      const mm = await getSetting('minimalMode', false);
      setMinimalMode(mm);
    })();
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

  // ── Connect socket ─────────────────────────────────────────────────────────
  const connectSocket = useCallback((token) => {
    const socket = io(API_URL, {
      auth: { token },
      transports: ['websocket'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      if (ghostMode) socket.emit('set_ghost_mode', true);
      // Drain offline inbox
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
      if (activeChat?.accountCode === from) {
        setMascotMood(MOODS.TYPING);
      }
    });
    socket.on('typing_stop', () => setMascotMood(MOODS.IDLE));
    socket.on('message_recalled', ({ messageId }) => {
      setMessages(prev => prev.filter(m => m.id !== messageId));
      deleteMessage(messageId);
    });
    socket.on('delivery_receipt', ({ messageId, status }) => {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, status } : m));
    });

    return socket;
  }, [ghostMode, activeChat]);

  // ── Incoming message handler ───────────────────────────────────────────────
  const handleIncomingMessage = useCallback(async (envelope) => {
    if (!keys || !envelope.payload) return;

    if (envelope.type === 'recall') {
      setMessages(prev => prev.filter(m => m.id !== envelope.targetId));
      await deleteMessage(envelope.targetId);
      return;
    }

    const decrypted = decryptMessage(envelope.payload, keys.secretKey);
    if (!decrypted) return;

    const msg = {
      id: envelope.id,
      from: envelope.from,
      content: typeof decrypted === 'string' ? decrypted : decrypted.content,
      selfDestructSeconds: envelope.selfDestructSeconds,
      selfDestructAt: envelope.selfDestructSeconds
        ? Date.now() + envelope.selfDestructSeconds * 1000
        : null,
      burnOnRead: decrypted.burnOnRead || false,
      ts: envelope.ts || Date.now(),
      status: 'received',
      conversationId: envelope.from,
    };

    await saveMessage(msg);

    if (activeChat?.accountCode === envelope.from) {
      setMessages(prev => [...prev, msg]);
    }

    setMascotMood(MOODS.EXCITED);
    setTimeout(() => setMascotMood(MOODS.IDLE), 2000);

    // Send delivery receipt
    socketRef.current?.emit('message_delivered', {
      messageId: envelope.id,
      senderCode: envelope.from,
    });

    // Auto-start self-destruct timer if set
    if (msg.selfDestructSeconds) {
      recallTimersRef.current.set(msg.id, setTimeout(async () => {
        await deleteMessage(msg.id);
        setMessages(prev => prev.filter(m => m.id !== msg.id));
      }, msg.selfDestructSeconds * 1000));
    }
  }, [keys, activeChat]);

  const handleIncomingVoice = useCallback(async (envelope) => {
    if (!keys || !envelope.payload) return;

    const decrypted = decryptBinary(envelope.payload, keys.secretKey);
    if (!decrypted) return;

    const blob = new Blob([decrypted], { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);

    const voiceMsg = {
      id: envelope.id,
      from: envelope.from,
      type: 'voice',
      audioUrl: url,
      duration: envelope.duration,
      ts: envelope.ts,
      conversationId: envelope.from,
    };

    await saveVoiceMessage(voiceMsg);
    if (activeChat?.accountCode === envelope.from) {
      setMessages(prev => [...prev, voiceMsg]);
    }
  }, [keys, activeChat]);

  // ── Registration ───────────────────────────────────────────────────────────
  const handleRegister = async (password) => {
    setPowSolving(true);
    setMascotMood(MOODS.TYPING);
    try {
      const challenge = await getPoWChallenge();
      showNotification('Solving security puzzle...', 'info');

      const solution = await solvePoW(challenge.challenge, challenge.difficulty);

      const result = await register(
        password,
        challenge.challenge,
        solution.nonce,
        challenge.timestamp
      );

      const kp = generateKeyPair();
      const exported = exportKeyPair(kp);

      await saveKeys(exported);
      await setSetting('accountCode', result.accountCode);
      await setSetting('friendCode', result.friendCode);
      await logLogin();

      setTokens(result.accessToken, result.refreshToken);
      // FIX (Bug 4): persist access token so unlock can reconnect socket
      await setSetting('accessToken', result.accessToken);
      await setPublicKey(exported.publicKey);

      setAccountCode(result.accountCode);
      setFriendCode(result.friendCode);
      setKeys(kp);
      storedPasswordRef.current = password;

      connectSocket(result.accessToken);
      setScreen('app');
      setMascotMood(MOODS.HAPPY);

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
      const result = await login(code, password);
      setTokens(result.accessToken, result.refreshToken);
      // FIX (Bug 4): persist access token so unlock can reconnect socket
      await setSetting('accessToken', result.accessToken);

      const savedKeys = await getKeys();
      if (!savedKeys) throw new Error('Keys not found. This may not be your device.');

      const kp = importKeyPair(savedKeys);
      setKeys(kp);
      setAccountCode(result.accountCode || code);
      const sc = await getSetting('friendCode');
      setFriendCode(sc);
      storedPasswordRef.current = password;

      await logLogin();

      // FIX (Bug 5): load pending requests and login history
      const { requests } = await getPendingRequests();
      setPendingRequests(requests);
      const history = await getLoginHistory();
      setLoginHistory(history);

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
      if (shouldRotateKeys(savedKeysData?.savedAt)) {
        handleKeyRotation(kp);
      }

    } catch (err) {
      showNotification(err.message, 'error');
      setMascotMood(MOODS.ALERT);
    }
  };

  // ── Unlock after inactivity ────────────────────────────────────────────────
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
    showNotification('Encryption keys rotated automatically', 'info');
  };

  // ── Send message ───────────────────────────────────────────────────────────
  const handleSendMessage = async () => {
    if (!inputText.trim() || !activeChat || !keys) return;

    const contactPubKey = await getPublicKey(activeChat.accountCode);
    if (!contactPubKey?.publicKey) {
      showNotification('Could not get recipient public key', 'error');
      return;
    }

    const msgContent = {
      content: inputText.trim(),
      burnOnRead: false,
    };

    const encrypted = encryptMessage(msgContent, contactPubKey.publicKey, keys.secretKey);

    const msgId = crypto.randomUUID();
    const msg = {
      id: msgId,
      from: accountCode,
      content: inputText.trim(),
      selfDestructSeconds: selfDestructTime,
      selfDestructAt: selfDestructTime ? Date.now() + selfDestructTime * 1000 : null,
      ts: Date.now(),
      status: 'sent',
      conversationId: activeChat.accountCode,
    };

    await saveMessage(msg);
    setMessages(prev => [...prev, msg]);
    setInputText('');

    recallTimersRef.current.set(msgId, null);
    setTimeout(() => {
      recallTimersRef.current.delete(msgId);
    }, 10000);

    try {
      socketRef.current?.emit('private_message', {
        id: msgId,
        recipientCode: activeChat.accountCode,
        payload: encrypted,
        selfDestructSeconds: selfDestructTime,
      });

      await sendMessage(activeChat.accountCode, encrypted, selfDestructTime);
    } catch (err) {
      showNotification('Failed to send message', 'error');
    }

    setMascotMood(MOODS.HAPPY);
    setTimeout(() => setMascotMood(MOODS.IDLE), 1000);
  };

  // ── Recall message ─────────────────────────────────────────────────────────
  const handleRecallMessage = async (msgId) => {
    if (!recallTimersRef.current.has(msgId)) {
      showNotification('Recall window expired (10 seconds)', 'error');
      return;
    }

    socketRef.current?.emit('recall_message', {
      messageId: msgId,
      recipientCode: activeChat.accountCode,
    });
    await apiRecall(msgId, activeChat.accountCode);
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
        await sendVoiceMessage(blob);
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

  const sendVoiceMessage = async (blob) => {
    if (!activeChat || !keys) return;

    const contactPubKey = await getPublicKey(activeChat.accountCode);
    if (!contactPubKey?.publicKey) return;

    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const encrypted = encryptBinary(uint8, contactPubKey.publicKey);

    socketRef.current?.emit('voice_message', {
      id: crypto.randomUUID(),
      recipientCode: activeChat.accountCode,
      payload: encrypted,
      duration: 0,
    });

    // FIX (Bug 6): pass encrypted object directly, not JSON.stringify
    await apiSendVoice(
      activeChat.accountCode,
      encrypted,
      0
    );
  };

  // ── Typing indicator ───────────────────────────────────────────────────────
  const handleInputChange = (e) => {
    setInputText(e.target.value);
    setMascotMood(MOODS.TYPING);

    socketRef.current?.emit('typing_start', { recipientCode: activeChat?.accountCode });

    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      setMascotMood(MOODS.IDLE);
      socketRef.current?.emit('typing_stop', { recipientCode: activeChat?.accountCode });
    }, 1500);
  };

  // ── Open conversation ──────────────────────────────────────────────────────
  const openChat = async (friend) => {
    setActiveChat(friend);
    const msgs = await getMessages(friend.accountCode);
    setMessages(msgs);
    socketRef.current?.emit('join_group', friend.accountCode);
    setMascotMood(MOODS.HAPPY);
  };

  // ── Panic wipe ─────────────────────────────────────────────────────────────
  const handlePanic = async () => {
    socketRef.current?.emit('panic');
    socketRef.current?.disconnect();
    clearTokens();
    await panicWipe();
    window.location.reload();
  };

  // ── Fingerprint verification ───────────────────────────────────────────────
  const showFingerprint = async (friendCode) => {
    const { publicKey } = await getPublicKey(friendCode);
    const fp = await getKeyFingerprint(publicKey);
    setFingerprintTarget({ code: friendCode, fingerprint: fp });
  };

  // ── Notification helper ────────────────────────────────────────────────────
  const showNotification = (message, type = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  // ── Logout ─────────────────────────────────────────────────────────────────
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

  if (sessionLocked) {
    return <LockScreen onUnlock={handleUnlock} mascotMood={mascotMood} />;
  }

  if (screen === 'register') {
    return (
      <RegisterScreen
        onRegister={handleRegister}
        onSwitchToLogin={() => setScreen('login')}
        mascotMood={powSolving ? MOODS.TYPING : mascotMood}
        solving={powSolving}
      />
    );
  }

  if (screen === 'login') {
    return (
      <LoginScreen
        onLogin={handleLogin}
        onSwitchToRegister={() => setScreen('register')}
        mascotMood={mascotMood}
        savedAccountCode={accountCode}
      />
    );
  }

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
        onToggleGhostMode={(v) => {
          setGhostMode(v);
          socketRef.current?.emit('set_ghost_mode', v);
        }}
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
          await addFriend(code);
          const { friends: fl } = await getFriends();
          setFriends(fl);
        }}
        notification={notification}
        loginHistory={loginHistory}
        keys={keys}
        onSendWorld={async (content) => {
          try {
            await sendWorldMessage(content);
          } catch (err) {
            showNotification(err.message, 'error');
          }
        }}
      />
    );
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Screen Components
// ────────────────────────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div className="screen center">
      <GhostMascot mood={MOODS.FLOATING} size={80} />
      <p style={{ color: 'rgba(255,255,255,0.5)', marginTop: 16 }}>Initializing...</p>
    </div>
  );
}

function LockScreen({ onUnlock, mascotMood }) {
  const [pw, setPw] = useState('');
  return (
    <div className="screen center">
      <GhostMascot mood={MOODS.LOCKED} size={80} />
      <h2 style={{ color: '#aac', margin: '16px 0 8px' }}>Locked</h2>
      <p style={{ color: 'rgba(255,255,255,0.4)', marginBottom: 24, fontSize: 14 }}>Session locked due to inactivity</p>
      <input
        type="password"
        placeholder="Enter password to unlock"
        value={pw}
        onChange={e => setPw(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && onUnlock(pw)}
        className="input"
        autoFocus
      />
      <button onClick={() => onUnlock(pw)} className="btn-primary" style={{ marginTop: 12 }}>
        Unlock
      </button>
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
        <div style={{ color: '#aac', fontSize: 14, margin: '16px 0' }}>
          🔐 Solving security puzzle — this takes a few seconds...
        </div>
      ) : (
        <div className="form">
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginBottom: 16 }}>
            No username. No email. Just a password.
          </p>
          <input
            type="password"
            placeholder="Choose a password (min 8 chars)"
            value={pw}
            onChange={e => setPw(e.target.value)}
            className="input"
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            className="input"
            style={{ marginTop: 8 }}
          />
          {err && <p style={{ color: '#ff6b6b', fontSize: 13, marginTop: 8 }}>{err}</p>}
          <button onClick={handleSubmit} className="btn-primary" style={{ marginTop: 16 }}>
            Create Ghost Account
          </button>
          <button onClick={onSwitchToLogin} className="btn-ghost" style={{ marginTop: 8 }}>
            Already have an account
          </button>
        </div>
      )}
    </div>
  );
}

function LoginScreen({ onLogin, onSwitchToRegister, mascotMood, savedAccountCode }) {
  const [code, setCode] = useState(savedAccountCode || '');
  const [pw, setPw] = useState('');

  return (
    <div className="screen center">
      <GhostMascot mood={mascotMood} size={100} />
      <h1 className="logo">Ghost Chat</h1>

      <div className="form">
        <input
          type="text"
          placeholder="Account code"
          value={code}
          onChange={e => setCode(e.target.value)}
          className="input"
          autoComplete="off"
          spellCheck={false}
        />
        <input
          type="password"
          placeholder="Password"
          value={pw}
          onChange={e => setPw(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onLogin(code, pw)}
          className="input"
          style={{ marginTop: 8 }}
        />
        <button onClick={() => onLogin(code, pw)} className="btn-primary" style={{ marginTop: 16 }}>
          Enter the Void
        </button>
        <button onClick={onSwitchToRegister} className="btn-ghost" style={{ marginTop: 8 }}>
          New ghost account
        </button>
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 16, textAlign: 'center' }}>
          ⚠️ Messages are stored on this device only. Uninstalling or clearing app data wipes your messages permanently.
        </p>
      </div>
    </div>
  );
}

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
  isDecoySession, onAddFriend,
  notification, loginHistory, keys, setFriends,
  onSendWorld,
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
      {/* Notification */}
      {notification && (
        <div className={`notification notification-${notification.type}`}>
          {notification.message}
        </div>
      )}

      {/* Fingerprint modal */}
      {fingerprintTarget && (
        <div className="modal-overlay" onClick={onCloseFP}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Key Fingerprint</h3>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
              Compare this with your contact out-of-band to verify no interception.
            </p>
            <code style={{ fontSize: 16, letterSpacing: 2, color: '#7af' }}>
              {fingerprintTarget.fingerprint}
            </code>
            <button onClick={onCloseFP} className="btn-ghost" style={{ marginTop: 16 }}>Close</button>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <GhostMascot mood={mascotMood} size={48} />
          <div style={{ flex: 1, marginLeft: 12 }}>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>Your code</div>
            <div
              style={{ fontSize: 13, fontFamily: 'monospace', color: '#aac', cursor: 'pointer' }}
              onClick={onCopyCode}
              title="Click to copy (auto-clears clipboard in 5s)"
            >
              {friendCode}
            </div>
          </div>
          <button
            onClick={onPanic}
            className="btn-panic"
            title="PANIC — wipe all data"
          >
            ☠
          </button>
        </div>

        <div className="tab-bar">
          {['chats', 'world', 'settings'].map(tab => (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            >
              {tab === 'chats' ? '💬' : tab === 'world' ? '🌐' : '⚙️'}
            </button>
          ))}
        </div>

        {activeTab === 'chats' && (
          <div className="friend-list">
            <button
              className="btn-ghost"
              style={{ margin: '8px 12px', fontSize: 13 }}
              onClick={() => setShowAddFriend(v => !v)}
            >
              + Add friend
            </button>
            {showAddFriend && (
              <div style={{ padding: '0 12px 12px' }}>
                <input
                  className="input"
                  placeholder="Friend code"
                  value={addFriendCode}
                  onChange={e => setAddFriendCode(e.target.value)}
                  style={{ fontSize: 13 }}
                />
                <button
                  className="btn-primary"
                  style={{ marginTop: 8, width: '100%' }}
                  onClick={async () => {
                    await onAddFriend(addFriendCode);
                    setAddFriendCode('');
                    setShowAddFriend(false);
                  }}
                >
                  Send Request
                </button>
              </div>
            )}
            {friends.map(f => (
              <div
                key={f.account_code}
                className={`friend-item ${activeChat?.accountCode === f.account_code ? 'active' : ''}`}
                onClick={() => onOpenChat({ accountCode: f.account_code })}
              >
                <div className="friend-avatar">
                  <GhostMascot mood={onlineUsers.has(f.account_code) ? MOODS.HAPPY : MOODS.SLEEPING} size={32} />
                </div>
                <div className="friend-info">
                  <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#ccd' }}>
                    {f.account_code.slice(0, 8)}...
                  </span>
                  <span style={{ fontSize: 11, color: onlineUsers.has(f.account_code) ? '#6f6' : 'rgba(255,255,255,0.3)' }}>
                    {onlineUsers.has(f.account_code) ? 'Online' : 'Offline'}
                  </span>
                </div>
                <button
                  className="fp-btn"
                  title="Verify key fingerprint"
                  onClick={e => { e.stopPropagation(); onShowFingerprint(f.account_code); }}
                >
                  🔑
                </button>
              </div>
            ))}
            {friends.length === 0 && (
              <p style={{ color: 'rgba(255,255,255,0.25)', fontSize: 13, padding: '16px', textAlign: 'center' }}>
                No friends yet. Share your friend code.
              </p>
            )}
          </div>
        )}

        {activeTab === 'world' && (
          <div className="world-list">
            <p style={{ padding: 12, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
              Anonymous world chat. No identity. 24h TTL.
            </p>
          </div>
        )}

        {activeTab === 'settings' && (
          <SettingsPanel
            ghostMode={ghostMode}
            onToggleGhostMode={onToggleGhostMode}
            minimalMode={minimalMode}
            onToggleMinimal={onToggleMinimal}
            onLogout={onLogout}
            accountCode={accountCode}
            showDecoySetup={showDecoySetup}
            onToggleDecoy={() => setShowDecoySetup(v => !v)}
            decoyPw={decoyPw}
            setDecoyPw={setDecoyPw}
            onSaveDecoy={async () => {
              await setDecoyPassword(decoyPw);
              setDecoyPw('');
              setShowDecoySetup(false);
            }}
          />
        )}
      </div>

      {/* Main content */}
      <div className="main">
        {activeTab === 'world' ? (
          <WorldChat messages={worldMessages} onSend={onSendWorld} />
        ) : activeChat ? (
          <>
            {/* Chat header */}
            <div className="chat-header">
              <GhostMascot mood={onlineUsers.has(activeChat.accountCode) ? MOODS.HAPPY : MOODS.IDLE} size={36} />
              <div style={{ flex: 1, marginLeft: 12 }}>
                <div style={{ fontFamily: 'monospace', color: '#ccd', fontSize: 14 }}>
                  {activeChat.accountCode.slice(0, 12)}...
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                  E2E Encrypted · Local storage only
                </div>
              </div>
            </div>

            {/* Messages */}
            <div className="messages">
              {messages.map(msg => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  isMine={msg.from === accountCode}
                  onRecall={onRecall}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="input-area">
              {/* Self-destruct selector */}
              <div className="destruct-row">
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginRight: 8 }}>💣</span>
                {DESTRUCT_OPTIONS.map(opt => (
                  <button
                    key={opt.label}
                    className={`destruct-btn ${selfDestructTime === opt.value ? 'active' : ''}`}
                    onClick={() => onSelfDestructChange(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="input-row">
                <input
                  className="input msg-input"
                  placeholder="Type a message..."
                  value={inputText}
                  onChange={onInputChange}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && onSend()}
                />
                <button
                  className={`voice-btn ${isRecording ? 'recording' : ''}`}
                  onMouseDown={onStartRecord}
                  onMouseUp={onStopRecord}
                  onTouchStart={onStartRecord}
                  onTouchEnd={onStopRecord}
                >
                  🎙
                </button>
                <button className="btn-primary send-btn" onClick={onSend}>
                  ↑
                </button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState />
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
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', display: 'block', marginTop: 4 }}>
          Voice message · {new Date(msg.ts).toLocaleTimeString()}
        </span>
      </div>
    );
  }

  return (
    <div className={`message ${isMine ? 'mine' : 'theirs'}`}>
      <div className="message-content">{msg.content}</div>
      <div className="message-meta">
        {timeLeft && <span style={{ color: '#f90', marginRight: 6 }}>💣 {timeLeft}s</span>}
        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>
          {new Date(msg.ts).toLocaleTimeString()}
        </span>
        {msg.status && <span style={{ marginLeft: 6, fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
          {msg.status === 'delivered' ? '✓✓' : msg.status === 'seen' ? '✓✓' : '✓'}
        </span>}
        {isMine && (
          <button
            onClick={() => onRecall(msg.id)}
            style={{ marginLeft: 8, background: 'none', border: 'none', color: 'rgba(255,100,100,0.6)', cursor: 'pointer', fontSize: 11 }}
          >
            recall
          </button>
        )}
      </div>
    </div>
  );
}

function WorldChat({ messages, onSend }) {
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
        {messages.map((msg, i) => (
          <div key={msg.id || i} className="message theirs">
            <div className="message-content">{msg.content}</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>
              {new Date(msg.ts || msg.created_at).toLocaleTimeString()}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="input-area">
        <div className="input-row">
          <input
            className="input msg-input"
            placeholder="Speak into the void..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { onSend(input); setInput(''); } }}
            maxLength={500}
          />
          <button className="btn-primary send-btn" onClick={() => { onSend(input); setInput(''); }}>↑</button>
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({ ghostMode, onToggleGhostMode, minimalMode, onToggleMinimal, onLogout,
  accountCode, showDecoySetup, onToggleDecoy, decoyPw, setDecoyPw, onSaveDecoy }) {
  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ color: '#aac', marginBottom: 16, fontSize: 14 }}>Settings</h3>

      <ToggleSetting label="👻 Ghost Mode" sublabel="Appear offline" value={ghostMode} onChange={onToggleGhostMode} />
      <ToggleSetting label="⬛ Minimal Mode" sublabel="Pure text UI" value={minimalMode} onChange={onToggleMinimal} />

      <div style={{ marginTop: 20 }}>
        <button className="btn-ghost" style={{ width: '100%', marginBottom: 8 }} onClick={onToggleDecoy}>
          🎭 Set Decoy Password
        </button>
        {showDecoySetup && (
          <div>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>
              Entering this password shows an empty fake chat. Use it if forced to unlock.
            </p>
            <input className="input" type="password" placeholder="Decoy password" value={decoyPw} onChange={e => setDecoyPw(e.target.value)} />
            <button className="btn-primary" style={{ marginTop: 8, width: '100%' }} onClick={onSaveDecoy}>Save Decoy</button>
          </div>
        )}
      </div>

      <div style={{ marginTop: 8 }}>
        <button className="btn-ghost" style={{ width: '100%', color: '#f66' }} onClick={onLogout}>
          Sign out
        </button>
      </div>

      <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', marginTop: 24, textAlign: 'center' }}>
        Account: {accountCode?.slice(0, 16)}...
      </p>
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
      <div
        onClick={() => onChange(!value)}
        style={{
          width: 42, height: 24, borderRadius: 12,
          background: value ? '#4a9' : 'rgba(255,255,255,0.15)',
          cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
        }}
      >
        <div style={{
          width: 18, height: 18, borderRadius: 9, background: 'white',
          position: 'absolute', top: 3, left: value ? 21 : 3,
          transition: 'left 0.2s',
        }} />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)' }}>
      <GhostMascot mood={MOODS.SLEEPING} size={80} />
      <p style={{ marginTop: 16 }}>Select a conversation</p>
    </div>
  );
}
