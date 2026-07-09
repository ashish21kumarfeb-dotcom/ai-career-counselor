// Decorative only: a small hand-drawn-style rocket that loops along a curved
// path with a short, fading sketchy trail. Pure SVG + SMIL (<animateMotion>) —
// no JS, no canvas. It renders behind content (-z-10), ignores pointer events,
// and is hidden for users who prefer reduced motion (see globals.css).
export function SketchRocket({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`sketch-rocket pointer-events-none absolute inset-0 -z-10 overflow-hidden ${className}`}
    >
      <svg
        className="h-full w-full"
        viewBox="0 0 1200 600"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          {/* Hand-drawn wobble — displaces the strokes slightly, stable per frame. */}
          <filter id="rkt-rough" x="-60%" y="-60%" width="220%" height="220%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.9"
              numOctaves="1"
              seed="7"
              result="n"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="n"
              scale="1.7"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>

          {/* Trail fade — opaque next to the rocket, transparent at the tail. */}
          <linearGradient id="rkt-trail" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>

          {/* Invisible flight route — a smooth closed loop that orbits AROUND the
              content (kept clear of the centre where the text sits) for a
              seamless cycle. */}
          <path
            id="rkt-path"
            fill="none"
            d="M 150,160 C 380,70 640,70 780,120 C 950,180 1050,120 1110,220 C 1160,360 1130,470 990,500 C 820,540 640,470 470,510 C 300,545 110,500 100,360 C 92,250 70,210 150,160 Z"
          />
        </defs>

        <g opacity="0.5">
          {/* This group both carries the wobble filter and rides the path. The
              rocket is drawn pointing +x; rotate="auto" keeps it nose-first and
              keeps the trail behind it as the path curves. */}
          <g filter="url(#rkt-rough)">
            {/* short sketchy trail, behind the rocket (toward -x) */}
            <path
              d="M -22,1 C -42,-4 -60,7 -82,-1"
              stroke="url(#rkt-trail)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="7 7"
              fill="none"
            />
            {/* body */}
            <path
              d="M -16,-9 C -15,-14 11,-13 20,0 C 11,13 -15,14 -16,9 Z"
              stroke="#ffffff"
              strokeWidth="2"
              strokeLinejoin="round"
              fill="rgba(255,255,255,0.06)"
            />
            {/* nose seam */}
            <path d="M 6,-11 C 12,-6 12,6 6,11" stroke="#ffffff" strokeWidth="1.5" fill="none" />
            {/* window */}
            <circle cx="-2" cy="0" r="4.2" stroke="#ffffff" strokeWidth="1.6" fill="none" />
            {/* fins */}
            <path
              d="M -14,-7 L -25,-14 L -12,-4"
              stroke="#ffffff"
              strokeWidth="1.8"
              fill="none"
              strokeLinejoin="round"
            />
            <path
              d="M -14,7 L -25,14 L -12,4"
              stroke="#ffffff"
              strokeWidth="1.8"
              fill="none"
              strokeLinejoin="round"
            />
            {/* little flame */}
            <path d="M -17,-3 C -25,-1 -25,1 -17,3" stroke="#ffffff" strokeWidth="1.6" fill="none" />

            <animateMotion dur="30s" repeatCount="indefinite" rotate="auto">
              <mpath href="#rkt-path" />
            </animateMotion>
          </g>
        </g>
      </svg>
    </div>
  );
}
