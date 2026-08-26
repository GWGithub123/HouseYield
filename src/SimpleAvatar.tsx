/**
 * Busimport SimpleAvatar from './SimpleAvatar';

export function AvatarsShowcase() {
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
      <SimpleAvatar width={120} height={160} />

      <SimpleAvatar
        width={140}
        height={180}
        title="Dark Suit Variant"
        desc="Avatar wearing a charcoal suit with teal tie"
        suitColor="#334155"
        suitColorDark="#1e293b"
        tieColor="#0ea5e9"
        tieColorDark="#0369a1"
        hairColor="#2f1f12"
        backgroundColor="#0ea5e922"
      />

      <SimpleAvatar
        width={110}
        height={150}
        title="Warm Palette"
        desc="Avatar in a rust suit with burgundy tie"
        suitColor="#b45309"
        suitColorDark="#7c2d12"
        tieColor="#92400e"
        tieColorDark="#78350f"
        hairColor="#5a3a20"
        skinColorLight="#f9e0d0"
        skinColorMid="#f3c2a3"
        skinColorDark="#e4a481"
        backgroundColor="#fcd34d33"
      />

      <SimpleAvatar
        width={105}
        height={140}
        hoverEffect={false}
        title="Static Version"
        desc="Avatar without hover lift effect"
        backgroundColor="transparent"
      />
    </div>
  );
}iness style SVG avatar component.
 * Scales to provided width/height using viewBox. Colors are customizable.
 */
interface SimpleAvatarProps {
  width?: number;
  height?: number;
  /** Primary suit jacket color */
  suitColor?: string;
  /** Secondary (shadow) suit color or gradient end */
  suitColorDark?: string;
  /** Tie base color */
  tieColor?: string;
  /** Tie darker accent */
  tieColorDark?: string;
  /** Hair base color */
  hairColor?: string;
  /** Skin base (center) */
  skinColorLight?: string;
  /** Skin mid tone */
  skinColorMid?: string;
  /** Skin shadow */
  skinColorDark?: string;
  /** Optional background (applied as subtle circle) */
  backgroundColor?: string;
  /** Accessible title */
  title?: string;
  /** Accessible description */
  desc?: string;
  /** Enable subtle hover lift & glow */
  hoverEffect?: boolean;
}

export default function SimpleAvatar({
  width = 105,
  height = 125,
  suitColor = '#1e3a8a',
  suitColorDark = '#1e2a5a',
  tieColor = '#f59e0b',
  tieColorDark = '#b45309',
  hairColor = '#6f4d2c',
  skinColorLight = '#f9d9c3',
  skinColorMid = '#f0c1a1',
  skinColorDark = '#e3aa8b',
  backgroundColor = 'transparent',
  title = 'Business avatar',
  desc = 'Professional figure wearing a blue suit and tie',
  hoverEffect = true
}: SimpleAvatarProps) {
  return (
    <div
      aria-label={title}
      style={{
        width,
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        transition: hoverEffect ? 'transform 320ms ease, filter 320ms ease' : undefined,
        cursor: hoverEffect ? 'pointer' : undefined
      }}
      className={hoverEffect ? 'business-avatar-wrapper' : undefined}
    >
      <style>{`
        @keyframes avatarFloat {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }

        @keyframes avatarBreath {
          0%, 100% { transform: scaleX(1) scaleY(1); }
          45% { transform: scaleX(0.98) scaleY(1.03); }
          55% { transform: scaleX(1.01) scaleY(0.99); }
        }

        @keyframes avatarHeadNod {
          0%, 100% { transform: rotate(0deg) translateY(0px); }
          40% { transform: rotate(-2deg) translateY(-1.5px); }
          70% { transform: rotate(1.5deg) translateY(1px); }
        }

        @keyframes avatarArmLeftWave {
          0%, 100% { transform: rotate(4deg); }
          50% { transform: rotate(-6deg); }
        }

        @keyframes avatarArmRightWave {
          0%, 100% { transform: rotate(-2deg); }
          50% { transform: rotate(5deg); }
        }

        @keyframes avatarHandPulse {
          0%, 100% { transform: translateY(0); }
          60% { transform: translateY(1.5px); }
        }

        @keyframes avatarBlink {
          0%, 92%, 100% { transform: scaleY(0); }
          94% { transform: scaleY(1); }
          96% { transform: scaleY(0); }
        }

        @keyframes avatarPupilDrift {
          0%, 100% { transform: translateX(0) translateY(0); }
          35% { transform: translateX(1.2px) translateY(0.6px); }
          70% { transform: translateX(-1px) translateY(-0.4px); }
        }

        @keyframes smilePulse {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(0.8px) scale(1.05); }
        }

        @keyframes avatarStatusPulse {
          0%, 100% { transform: scale(1); opacity: 0.9; }
          50% { transform: scale(1.3); opacity: 0.6; }
        }

  .avatar-container { animation: avatarFloat 5s ease-in-out infinite; }
  .business-avatar-wrapper:hover { transform: translateY(-4px); filter: drop-shadow(0 4px 10px rgba(0,0,0,0.15)); }
    .avatar-arm,
    .avatar-hand,
    .avatar-head,
    .avatar-torso,
    .avatar-pupils,
    .avatar-eyelid { transform-box: fill-box; }
    .avatar-torso { animation: avatarBreath 6s ease-in-out infinite; transform-origin: 50% 80%; }
    .avatar-head { animation: avatarHeadNod 6.5s ease-in-out infinite; transform-origin: 50% 30%; }
    .avatar-arm { transform-origin: top center; }
    .avatar-arm-left { animation: avatarArmLeftWave 5.5s ease-in-out infinite; }
    .avatar-arm-right { animation: avatarArmRightWave 4.8s ease-in-out infinite; }
    .avatar-hand { animation: avatarHandPulse 3.4s ease-in-out infinite; transform-origin: center; }
    .avatar-eyelid { transform-origin: 50% 0%; transform: scaleY(0); animation: avatarBlink 5.6s ease-in-out infinite; }
    .avatar-pupils { animation: avatarPupilDrift 7s ease-in-out infinite; transform-origin: center; }
    .avatar-mouth { animation: smilePulse 3.2s ease-in-out infinite; transform-origin: 50% 50%; }
      `}</style>
      
      <div className="avatar-container">
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 160 220"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-labelledby="avatarTitle avatarDesc"
        >
          <title id="avatarTitle">{title}</title>
          <desc id="avatarDesc">{desc}</desc>
          <defs>
            <radialGradient id="avatarSkin" cx="50%" cy="35%" r="70%">
              <stop offset="0%" stopColor={skinColorLight} />
              <stop offset="70%" stopColor={skinColorMid} />
              <stop offset="100%" stopColor={skinColorDark} />
            </radialGradient>
            <radialGradient id="avatarSkinShade" cx="50%" cy="20%" r="100%">
              <stop offset="0%" stopColor={skinColorLight} stopOpacity="0.85" />
              <stop offset="100%" stopColor={skinColorDark} stopOpacity="0.4" />
            </radialGradient>
            <linearGradient id="avatarSuit" x1="0%" x2="100%" y1="0%" y2="100%">
              <stop offset="0%" stopColor={suitColor} />
              <stop offset="100%" stopColor={suitColorDark} />
            </linearGradient>
            <linearGradient id="avatarTie" x1="0%" x2="0%" y1="0%" y2="100%">
              <stop offset="0%" stopColor={tieColor} />
              <stop offset="100%" stopColor={tieColorDark} />
            </linearGradient>
            <linearGradient id="avatarHair" x1="0%" x2="100%" y1="0%" y2="100%">
              <stop offset="0%" stopColor={hairColor} />
              <stop offset="100%" stopColor={hairColor} stopOpacity="0.8" />
            </linearGradient>
            <filter id="avatarSoftShadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="6" stdDeviation="12" floodColor="#1f2937" floodOpacity="0.18" />
            </filter>
          </defs>

          {backgroundColor !== 'transparent' && (
            <circle cx="80" cy="110" r="78" fill={backgroundColor} opacity="0.18" />
          )}

          {/* ground shadow */}
          <ellipse cx="80" cy="205" rx="36" ry="10" fill="#000" opacity="0.08" />

          {/* Neck */}
          <rect x="70" y="86" width="20" height="18" rx="9" fill="url(#avatarSkin)" />

          {/* Arms (behind torso) */}
          <g fill="url(#avatarSkin)">
            <g className="avatar-arm avatar-arm-left">
              <path d="M62 108 C58 114 58 128 60 142 C62 156 70 158 74 146 C74 132 74 120 72 110 C70 104 66 102 62 108 Z" opacity="0.96" />
            </g>
            <g className="avatar-arm avatar-arm-right">
              <path d="M98 108 C102 114 102 128 100 142 C98 156 90 158 86 146 C86 132 86 120 88 110 C90 104 94 102 98 108 Z" opacity="0.96" />
            </g>
          </g>

          {/* Torso (Reworked for suit jacket with lapels + shirt + tie) */}
          <g className="avatar-torso" filter="url(#avatarSoftShadow)">
            {/* Jacket base */}
            <path
              d="M56 90 C50 102 50 128 56 150 C60 166 68 176 80 176 C92 176 100 166 104 150 C110 128 110 102 104 90 C100 82 60 82 56 90 Z"
              fill="url(#avatarSuit)"
            />
            {/* Shirt visible area */}
            <path d="M66 92 L74 108 L74 144 Q80 148 86 144 L86 108 L94 92 Q80 86 66 92 Z" fill="#ffffff" opacity="0.94" />
            {/* Lapels */}
            <path d="M56 90 L66 92 L74 108 L68 144 L58 136 C54 120 54 104 56 90 Z" fill={suitColorDark} opacity="0.85" />
            <path d="M104 90 L94 92 L86 108 L92 144 L102 136 C106 120 106 104 104 90 Z" fill={suitColorDark} opacity="0.85" />
            {/* Tie */}
            <path d="M74 108 L80 104 L86 108 L82 142 L80 146 L78 142 Z" fill="url(#avatarTie)" />
            <path d="M74 108 L80 112 L86 108 L80 104 Z" fill={tieColorDark} opacity="0.4" />
            {/* Shirt collar */}
            <path d="M66 92 L74 108 L80 104 L86 108 L94 92 C86 88 74 88 66 92 Z" fill="#e2e8f0" opacity="0.9" />
            {/* Buttons */}
            <circle cx="80" cy="122" r="2.2" fill="#94a3b8" />
            <circle cx="80" cy="134" r="2.2" fill="#94a3b8" />
          </g>

          {/* Hands */}
          <g fill="url(#avatarSkin)">
            <circle className="avatar-hand avatar-hand-left" cx="60" cy="154" r="8" />
            <circle className="avatar-hand avatar-hand-right" cx="100" cy="154" r="8" />
          </g>

          {/* Head */}
          <g className="avatar-head">
            <ellipse cx="80" cy="60" rx="26" ry="28" fill="url(#avatarSkin)" />
            <ellipse cx="80" cy="61" rx="24" ry="27" fill="url(#avatarSkinShade)" opacity="0.25" />

            {/* Hair */}
            <path
              d="M54 44 C58 28 72 20 84 22 C98 24 110 34 112 52 C106 46 92 42 84 44 C74 34 64 32 56 36 C52 38 50 40 54 44 Z"
              fill="url(#avatarHair)"
            />
            <path d="M62 36 Q80 28 98 40" stroke="#2f1f12" strokeWidth="3" strokeLinecap="round" opacity="0.35" />

            {/* Ears */}
            <g fill="url(#avatarSkin)">
              <ellipse cx="56" cy="60" rx="5" ry="8" />
              <ellipse cx="104" cy="60" rx="5" ry="8" />
              <ellipse cx="56" cy="60" rx="2.5" ry="4" fill="#f1c9a8" />
              <ellipse cx="104" cy="60" rx="2.5" ry="4" fill="#f1c9a8" />
            </g>

            {/* Brows */}
            <path d="M64 54 Q72 48 80 52" stroke="#3f2f1d" strokeWidth="3" strokeLinecap="round" />
            <path d="M96 54 Q88 48 80 52" stroke="#3f2f1d" strokeWidth="3" strokeLinecap="round" />

            {/* Eyes */}
            <g>
              <ellipse cx="70" cy="58" rx="7" ry="4.2" fill="#f8fafc" />
              <ellipse cx="90" cy="58" rx="7" ry="4.2" fill="#f8fafc" />
              <g className="avatar-pupils">
                <circle cx="70" cy="59" r="3" fill="#2563eb" />
                <circle cx="90" cy="59" r="3" fill="#2563eb" />
                <circle cx="71" cy="58" r="1.2" fill="white" opacity="0.85" />
                <circle cx="91" cy="58" r="1.2" fill="white" opacity="0.85" />
              </g>
              <g transform="translate(63,52)">
                <g className="avatar-eyelid">
                  <path d="M0 0 Q7 -6 14 0 Q7 2 0 0" fill="#f7d3b7" opacity="0.9" />
                </g>
              </g>
              <g transform="translate(83,52)">
                <g className="avatar-eyelid">
                  <path d="M0 0 Q7 -6 14 0 Q7 2 0 0" fill="#f7d3b7" opacity="0.9" />
                </g>
              </g>
            </g>

            {/* Nose */}
            <path d="M79 64 Q78 70 80 74 Q82 70 81 64" fill="#e8b191" />
            <circle cx="78" cy="72" r="1.2" fill="#d79576" />
            <circle cx="82" cy="72" r="1.2" fill="#d79576" />

            {/* Mouth */}
            <g className="avatar-mouth">
              <path
                d="M70 78 Q80 86 90 78"
                stroke="#d97706"
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
              />
              <path d="M74 80 Q80 84 86 80" stroke="#ef4444" strokeWidth="1.2" opacity="0.45" fill="none" />
            </g>
            {/* Chin shadow */}
            <path d="M70 84 Q80 88 90 84" stroke="#d19a7f" strokeWidth="2" opacity="0.22" strokeLinecap="round" />
          </g>

          {/* Belt and pants (reuse suit color but darker for continuity) */}
          <path d="M64 150 H96 L94 188 C92 198 86 204 80 204 C74 204 68 198 66 188 Z" fill={suitColorDark} />
          <rect x="62" y="144" width="36" height="9" rx="4" fill={suitColor} opacity="0.9" />
          <circle cx="80" cy="148.5" r="2" fill="#cbd5f5" />

          {/* Legs */}
          <rect x="66" y="188" width="12" height="24" rx="6" fill="#0f172a" />
          <rect x="82" y="188" width="12" height="24" rx="6" fill="#0f172a" />

          {/* Shoes */}
          <path d="M60 210 C62 206 68 204 74 204 C78 204 84 205 86 210 C84 214 60 214 60 210 Z" fill="#1f2937" />
          <path d="M86 210 C88 206 94 204 100 204 C104 204 110 205 112 210 C110 214 86 214 86 210 Z" fill="#1f2937" />
        </svg>
      </div>
      
      {/* Status indicator */}
      <div 
        style={{
          position: 'absolute',
          bottom: '9px',
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: '9px',
          color: '#059669',
          fontWeight: '500',
          display: 'flex',
          alignItems: 'center',
          gap: '3px'
        }}
      >
        <div 
          style={{
            width: '4px',
            height: '4px',
            borderRadius: '50%',
            backgroundColor: '#10b981',
            animation: 'avatarStatusPulse 2.2s ease-in-out infinite'
          }}
        />
        AI Ready
      </div>
    </div>
  );
}
