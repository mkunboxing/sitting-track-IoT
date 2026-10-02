import React from 'react';

interface LogoProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'icon' | 'full';
  animated?: boolean;
  className?: string;
}

export function Logo({
  size = 'md',
  variant = 'icon',
  animated = true,
  className = '',
}: LogoProps) {
  const sizeMap = {
    xs: { box: 24, iconClass: 'w-6 h-6' },
    sm: { box: 32, iconClass: 'w-8 h-8' },
    md: { box: 40, iconClass: 'w-10 h-10' },
    lg: { box: 48, iconClass: 'w-12 h-12' },
    xl: { box: 64, iconClass: 'w-16 h-16' },
  };

  const { iconClass } = sizeMap[size];

  const svgContent = (
    <svg
      viewBox="0 0 128 128"
      className={`${iconClass} drop-shadow-md select-none transition-transform duration-200 group-hover:scale-105`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        {/* Background Dark Gradient */}
        <linearGradient id="logoBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--logo-bg-0)" />
          <stop offset="50%" stopColor="var(--logo-bg-1)" />
          <stop offset="100%" stopColor="var(--logo-bg-2)" />
        </linearGradient>

        {/* Ambient Ring Border Gradient */}
        <linearGradient id="logoBorder" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#34d399" stopOpacity="0.8" />
          <stop offset="50%" stopColor="#14b8a6" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.6" />
        </linearGradient>

        {/* Chair Primary Emerald / Teal Gradient */}
        <linearGradient id="chairPrimary" x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="50%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#0d9488" />
        </linearGradient>

        {/* Telemetry Ultrasonic Arcs Gradient */}
        <linearGradient id="telemetryArcs" x1="0%" y1="30%" x2="100%" y2="70%">
          <stop offset="0%" stopColor="#2dd4bf" />
          <stop offset="50%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#818cf8" />
        </linearGradient>

        {/* Subtle Ambient Radial Glow */}
        <radialGradient id="centerGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Rounded Squircle Container */}
      <rect
        x="6"
        y="6"
        width="116"
        height="116"
        rx="30"
        fill="url(#logoBg)"
        stroke="url(#logoBorder)"
        strokeWidth="2.5"
      />

      {/* Internal ambient illumination */}
      <circle cx="58" cy="62" r="36" fill="url(#centerGlow)" />

      {/* Ergonomic Chair Graphic */}
      <g>
        {/* Headrest */}
        <rect x="42" y="25" width="16" height="8" rx="4" fill="url(#chairPrimary)" />
        {/* Headrest post */}
        <path d="M 50 33 L 50 38" stroke="#10b981" strokeWidth="3" strokeLinecap="round" />

        {/* Ergonomic Backrest Spine Contour */}
        <path
          d="M 50 38 C 42 44, 42 54, 47 62 C 49 66, 50 69, 49 74"
          fill="none"
          stroke="url(#chairPrimary)"
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Lumbar support contour accent */}
        <path
          d="M 44.5 56 C 46.5 58, 47.5 61, 46 64"
          fill="none"
          stroke="#a7f3d0"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.9"
        />

        {/* Ergonomic Seat Cushion */}
        <path
          d="M 44 74 L 75 74 C 77.5 74, 79 75.5, 78 78 L 77.5 79 C 76.5 80.5, 74.5 81, 72.5 81 L 45 81 C 42.5 81, 41 78.5, 42.5 75.5 Z"
          fill="url(#chairPrimary)"
        />

        {/* Gas Lift Pneumatic Cylinder */}
        <path d="M 59 81 L 59 93" stroke="#14b8a6" strokeWidth="4.5" strokeLinecap="round" />

        {/* Star Base & Casters */}
        <path
          d="M 39 99 L 59 93 L 79 99"
          stroke="url(#chairPrimary)"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="39" cy="99" r="2.8" fill="#34d399" />
        <circle cx="59" cy="94" r="2.2" fill="#2dd4bf" />
        <circle cx="79" cy="99" r="2.8" fill="#34d399" />

        {/* HC-SR04 Ultrasonic Telemetry Presence Waves */}
        <path
          d="M 83 49 A 17 17 0 0 1 83 67"
          fill="none"
          stroke="url(#telemetryArcs)"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <path
          d="M 93 42 A 29 29 0 0 1 93 74"
          fill="none"
          stroke="url(#telemetryArcs)"
          strokeWidth="3"
          strokeLinecap="round"
          opacity="0.8"
        />
        <path
          d="M 103 35 A 41 41 0 0 1 103 81"
          fill="none"
          stroke="url(#telemetryArcs)"
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.5"
        />

        {/* Smart Sensor Live Pulse Point */}
        <circle cx="73" cy="58" r="3.2" fill="#a7f3d0" />
      </g>
    </svg>
  );

  if (variant === 'icon') {
    return (
      <div className={`relative inline-flex items-center justify-center ${className}`}>
        {svgContent}
        {animated && (
          <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5 pointer-events-none">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500 ring-2 ring-white dark:ring-zinc-900" />
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="relative flex-shrink-0">
        {svgContent}
        {animated && (
          <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5 pointer-events-none">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500 ring-2 ring-white dark:ring-zinc-900" />
          </span>
        )}
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-tight text-ink-bright group-hover:text-acc-emerald-soft transition-colors">
            Sitting Time Tracker
          </span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-acc-emerald border border-emerald-500/20">
            IoT
          </span>
        </div>
        <p className="text-xs text-ink4">
          Smart Ergonomics &amp; Ultrasonic Telemetry
        </p>
      </div>
    </div>
  );
}
