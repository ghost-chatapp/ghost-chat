import { useState, useEffect, useRef } from 'react';

// 8 mood states
export const MOODS = {
  IDLE: 'idle',
  SLEEPING: 'sleeping',
  TYPING: 'typing',
  EXCITED: 'excited',
  ALERT: 'alert',
  HAPPY: 'happy',
  SPOOKED: 'spooked',
  LOCKED: 'locked',
};

const ACCESSORIES = ['none', 'hat', 'crown', 'glasses', 'headphones'];

export default function GhostMascot({ mood = MOODS.IDLE, size = 80, onClick }) {
  const [tapCount, setTapCount] = useState(0);
  const [easterEgg, setEasterEgg] = useState(false);
  const [accessory, setAccessory] = useState('none');
  const [blink, setBlink] = useState(false);
  const tapTimer = useRef(null);

  // Load accessory from storage
  useEffect(() => {
    const saved = localStorage.getItem('ghost_accessory');
    if (saved && ACCESSORIES.includes(saved)) setAccessory(saved);
  }, []);

  // Blink animation
  useEffect(() => {
    if (mood === MOODS.SLEEPING || mood === MOODS.LOCKED) return;
    const interval = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 120);
    }, 3000 + Math.random() * 2000);
    return () => clearInterval(interval);
  }, [mood]);

  const handleTap = () => {
    const newCount = tapCount + 1;
    setTapCount(newCount);

    clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => setTapCount(0), 2000);

    if (newCount >= 7) {
      setEasterEgg(true);
      setTapCount(0);
      // Cycle accessory
      const next = ACCESSORIES[(ACCESSORIES.indexOf(accessory) + 1) % ACCESSORIES.length];
      setAccessory(next);
      localStorage.setItem('ghost_accessory', next);
      setTimeout(() => setEasterEgg(false), 2000);
    }

    onClick?.();
  };

  const eyeStyle = blink ? 'scaleY(0.1)' : 'scaleY(1)';
  const animClass = getMoodAnimation(mood);

  return (
    <div
      onClick={handleTap}
      style={{
        cursor: 'pointer',
        userSelect: 'none',
        display: 'inline-block',
        position: 'relative',
      }}
    >
      <svg
        width={size}
        height={size * 1.2}
        viewBox="0 0 100 120"
        className={animClass}
        style={{ overflow: 'visible', filter: getMoodFilter(mood) }}
      >
        {/* Ghost body */}
        <defs>
          <linearGradient id="ghostGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={getMoodColor(mood)} />
            <stop offset="100%" stopColor={getMoodColorDark(mood)} />
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Shadow */}
        <ellipse cx="50" cy="115" rx="25" ry="5" fill="rgba(0,0,0,0.2)" />

        {/* Body */}
        <path
          d={getBodyPath(mood)}
          fill="url(#ghostGrad)"
          filter="url(#glow)"
        />

        {/* Eyes */}
        <g transform={`translate(50, 45)`} style={{ transformOrigin: 'center' }}>
          {/* Left eye */}
          <ellipse
            cx="-14"
            cy="0"
            rx="8"
            ry="9"
            fill="rgba(0,0,0,0.85)"
            style={{ transform: eyeStyle, transformOrigin: '-14px 0px', transition: 'transform 0.05s' }}
          />
          {/* Right eye */}
          <ellipse
            cx="14"
            cy="0"
            rx="8"
            ry="9"
            fill="rgba(0,0,0,0.85)"
            style={{ transform: eyeStyle, transformOrigin: '14px 0px', transition: 'transform 0.05s' }}
          />
          {/* Eye shine left */}
          <circle cx="-11" cy="-3" r="2.5" fill="white" opacity="0.8" />
          {/* Eye shine right */}
          <circle cx="17" cy="-3" r="2.5" fill="white" opacity="0.8" />
        </g>

        {/* Mood expression */}
        {getMoodExpression(mood)}

        {/* Accessories */}
        {accessory === 'hat' && (
          <g>
            <rect x="25" y="8" width="50" height="6" rx="2" fill="#1a1a2e" />
            <rect x="32" y="-12" width="36" height="22" rx="4" fill="#1a1a2e" />
          </g>
        )}
        {accessory === 'crown' && (
          <g fill="#ffd700">
            <polygon points="28,14 35,0 42,14" />
            <polygon points="43,14 50,0 57,14" />
            <polygon points="58,14 65,0 72,14" />
            <rect x="28" y="12" width="44" height="8" rx="2" />
          </g>
        )}
        {accessory === 'glasses' && (
          <g fill="none" stroke="#1a1a2e" strokeWidth="2.5">
            <circle cx="36" cy="45" r="11" />
            <circle cx="64" cy="45" r="11" />
            <line x1="47" y1="45" x2="53" y2="45" />
            <line x1="20" y1="42" x2="25" y2="44" />
            <line x1="75" y1="44" x2="80" y2="42" />
          </g>
        )}
        {accessory === 'headphones' && (
          <g>
            <path d="M 20 40 Q 50 15 80 40" fill="none" stroke="#333" strokeWidth="4" />
            <rect x="14" y="36" width="12" height="18" rx="6" fill="#333" />
            <rect x="74" y="36" width="12" height="18" rx="6" fill="#333" />
          </g>
        )}

        {/* Easter egg sparkles */}
        {easterEgg && (
          <g className="sparkle">
            {[0, 60, 120, 180, 240, 300].map((angle, i) => (
              <circle
                key={i}
                cx={50 + 45 * Math.cos(angle * Math.PI / 180)}
                cy={50 + 45 * Math.sin(angle * Math.PI / 180)}
                r="3"
                fill="#ffd700"
                opacity="0.9"
              />
            ))}
          </g>
        )}
      </svg>

      {/* Tap counter hint */}
      {tapCount > 3 && tapCount < 7 && (
        <div style={{
          position: 'absolute',
          bottom: -20,
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: '10px',
          color: 'rgba(255,255,255,0.5)',
          whiteSpace: 'nowrap',
        }}>
          {7 - tapCount} more...
        </div>
      )}
    </div>
  );
}

function getBodyPath(mood) {
  if (mood === MOODS.SPOOKED) {
    return 'M 50 5 C 20 5 10 25 10 45 L 10 85 L 20 75 L 30 85 L 40 72 L 50 85 L 60 72 L 70 85 L 80 75 L 90 85 L 90 45 C 90 25 80 5 50 5 Z';
  }
  return 'M 50 8 C 22 8 12 28 12 48 L 12 88 L 22 78 L 33 88 L 44 78 L 50 88 L 56 78 L 67 88 L 78 78 L 88 88 L 88 48 C 88 28 78 8 50 8 Z';
}

function getMoodColor(mood) {
  const colors = {
    [MOODS.IDLE]: '#c8d8f0',
    [MOODS.SLEEPING]: '#a8b8d0',
    [MOODS.TYPING]: '#d8e8ff',
    [MOODS.EXCITED]: '#e0f0ff',
    [MOODS.ALERT]: '#ffd8d8',
    [MOODS.HAPPY]: '#d8ffe8',
    [MOODS.SPOOKED]: '#f0d8ff',
    [MOODS.LOCKED]: '#888899',
  };
  return colors[mood] || '#c8d8f0';
}

function getMoodColorDark(mood) {
  const colors = {
    [MOODS.IDLE]: '#a0b4d0',
    [MOODS.SLEEPING]: '#8090b0',
    [MOODS.TYPING]: '#b0c8f0',
    [MOODS.EXCITED]: '#b0d0ff',
    [MOODS.ALERT]: '#ffb0b0',
    [MOODS.HAPPY]: '#b0ffc8',
    [MOODS.SPOOKED]: '#d0a0f0',
    [MOODS.LOCKED]: '#606070',
  };
  return colors[mood] || '#a0b4d0';
}

function getMoodFilter(mood) {
  if (mood === MOODS.EXCITED) return 'drop-shadow(0 0 8px rgba(100,160,255,0.6))';
  if (mood === MOODS.ALERT) return 'drop-shadow(0 0 8px rgba(255,80,80,0.6))';
  if (mood === MOODS.HAPPY) return 'drop-shadow(0 0 8px rgba(80,255,160,0.5))';
  if (mood === MOODS.SPOOKED) return 'drop-shadow(0 0 12px rgba(200,100,255,0.7))';
  return 'drop-shadow(0 2px 6px rgba(0,0,0,0.3))';
}

function getMoodAnimation(mood) {
  if (mood === MOODS.TYPING) return 'ghost-bounce';
  if (mood === MOODS.EXCITED) return 'ghost-shake';
  if (mood === MOODS.SLEEPING) return 'ghost-float-slow';
  if (mood === MOODS.SPOOKED) return 'ghost-jitter';
  return 'ghost-float';
}

function getMoodExpression(mood) {
  if (mood === MOODS.SLEEPING) {
    return (
      <g>
        <path d="M 38 58 Q 50 52 62 58" fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="2.5" strokeLinecap="round" />
        <text x="68" y="30" fontSize="14" fill="rgba(150,180,255,0.8)">z</text>
        <text x="76" y="22" fontSize="10" fill="rgba(150,180,255,0.6)">z</text>
      </g>
    );
  }
  if (mood === MOODS.HAPPY) {
    return <path d="M 36 60 Q 50 72 64 60" fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth="3" strokeLinecap="round" />;
  }
  if (mood === MOODS.EXCITED) {
    return <path d="M 34 58 Q 50 74 66 58" fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth="3" strokeLinecap="round" />;
  }
  if (mood === MOODS.ALERT) {
    return <path d="M 36 64 Q 50 56 64 64" fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="2.5" strokeLinecap="round" />;
  }
  if (mood === MOODS.SPOOKED) {
    return (
      <ellipse cx="50" cy="62" rx="10" ry="8" fill="rgba(0,0,0,0.7)" />
    );
  }
  if (mood === MOODS.LOCKED) {
    return <line x1="38" y1="62" x2="62" y2="62" stroke="rgba(0,0,0,0.4)" strokeWidth="2.5" strokeLinecap="round" />;
  }
  if (mood === MOODS.TYPING) {
    return (
      <g>
        <circle cx="42" cy="62" r="2.5" fill="rgba(0,0,0,0.5)" className="dot-pulse" />
        <circle cx="50" cy="62" r="2.5" fill="rgba(0,0,0,0.5)" className="dot-pulse dot-pulse-2" />
        <circle cx="58" cy="62" r="2.5" fill="rgba(0,0,0,0.5)" className="dot-pulse dot-pulse-3" />
      </g>
    );
  }
  // Default idle - slight smile
  return <path d="M 40 62 Q 50 68 60 62" fill="none" stroke="rgba(0,0,0,0.4)" strokeWidth="2.5" strokeLinecap="round" />;
}
