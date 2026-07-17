// Decorative only: a global space-themed background layer — twinkling stars,
// occasional shooting stars, and a few doodle planets. Pure CSS/SVG, fixed
// behind all content, pointer-events-none, aria-hidden, and calmed down for
// users who prefer reduced motion (see globals.css).

// Scattered stars: top/left (%), size (px), duration & delay (s).
const STARS = [
  { t: "6%", l: "14%", s: 2, u: "4s", d: "0s" },
  { t: "11%", l: "32%", s: 1.5, u: "5s", d: "1.2s" },
  { t: "9%", l: "62%", s: 2.5, u: "4.6s", d: "0.4s" },
  { t: "5%", l: "82%", s: 1.5, u: "5.4s", d: "2s" },
  { t: "18%", l: "8%", s: 2, u: "4.2s", d: "0.8s" },
  { t: "22%", l: "46%", s: 1.5, u: "5.2s", d: "1.6s" },
  { t: "17%", l: "73%", s: 2, u: "4.8s", d: "0.2s" },
  { t: "26%", l: "90%", s: 1.5, u: "5s", d: "2.4s" },
  { t: "32%", l: "20%", s: 2.5, u: "4.4s", d: "1s" },
  { t: "36%", l: "56%", s: 1.5, u: "5.6s", d: "0.6s" },
  { t: "40%", l: "86%", s: 2, u: "4.2s", d: "1.8s" },
  { t: "46%", l: "6%", s: 1.5, u: "5s", d: "1.4s" },
  { t: "50%", l: "40%", s: 2, u: "4.6s", d: "0.3s" },
  { t: "54%", l: "70%", s: 1.5, u: "5.2s", d: "2.2s" },
  { t: "60%", l: "16%", s: 2.5, u: "4.4s", d: "0.9s" },
  { t: "64%", l: "52%", s: 1.5, u: "5.4s", d: "1.7s" },
  { t: "68%", l: "88%", s: 2, u: "4.8s", d: "0.5s" },
  { t: "74%", l: "28%", s: 1.5, u: "5s", d: "2s" },
  { t: "78%", l: "62%", s: 2, u: "4.6s", d: "1.1s" },
  { t: "82%", l: "10%", s: 1.5, u: "5.2s", d: "0.7s" },
  { t: "86%", l: "44%", s: 2.5, u: "4.4s", d: "1.5s" },
  { t: "88%", l: "78%", s: 1.5, u: "5.6s", d: "0.4s" },
  { t: "92%", l: "24%", s: 2, u: "4.8s", d: "2.1s" },
  { t: "94%", l: "92%", s: 1.5, u: "5s", d: "1.3s" },
  { t: "30%", l: "34%", s: 1.5, u: "5.2s", d: "0.6s" },
  { t: "70%", l: "40%", s: 1.5, u: "4.6s", d: "1.9s" },
];

// Shooting stars: start position, diagonal angle, duration & delay — long,
// staggered cycles so they streak only occasionally.
const SHOOTERS = [
  { t: "12%", l: "6%", rot: 20, u: "11s", d: "0s" },
  { t: "6%", l: "56%", rot: 27, u: "13s", d: "4.5s" },
  { t: "38%", l: "26%", rot: 15, u: "16s", d: "8.5s" },
];

export function SpaceBackground() {
  return (
    <div
      aria-hidden="true"
      className="space-decor pointer-events-none fixed inset-0 -z-[1] select-none overflow-hidden"
    >
      {STARS.map((s, i) => (
        <span
          key={`star-${i}`}
          className="star"
          style={{ top: s.t, left: s.l, width: s.s, height: s.s, animationDuration: s.u, animationDelay: s.d }}
        />
      ))}

      {SHOOTERS.map((s, i) => (
        <span
          key={`shoot-${i}`}
          className="ss-wrap absolute"
          style={{ top: s.t, left: s.l, transform: `rotate(${s.rot}deg)` }}
        >
          <span className="ss-streak" style={{ animationDuration: s.u, animationDelay: s.d }} />
        </span>
      ))}

      {/* Saturn — top-right */}
      <div className="planet hidden sm:block" style={{ top: "8%", right: "5%", opacity: 0.16 }}>
        <svg width="118" height="96" viewBox="0 0 130 106" fill="none">
          <ellipse
            cx="65"
            cy="56"
            rx="56"
            ry="16"
            stroke="#38bdf8"
            strokeWidth="2"
            transform="rotate(-16 65 56)"
          />
          <circle cx="65" cy="54" r="26" fill="rgba(56,189,248,0.06)" stroke="#38bdf8" strokeWidth="2" />
          <path d="M 42,48 Q 65,56 88,48" stroke="#5cc0e6" strokeWidth="1.3" fill="none" opacity="0.65" />
        </svg>
      </div>

      {/* Pluto — bottom-left */}
      <div className="planet" style={{ bottom: "12%", left: "5%", opacity: 0.18, animationDelay: "3s" }}>
        <svg width="52" height="52" viewBox="0 0 60 60" fill="none">
          <circle cx="30" cy="30" r="20" fill="rgba(56,189,248,0.06)" stroke="#38bdf8" strokeWidth="2" />
          <circle cx="23" cy="25" r="3.4" stroke="#5cc0e6" strokeWidth="1.2" fill="none" opacity="0.65" />
          <circle cx="36" cy="34" r="2.4" stroke="#5cc0e6" strokeWidth="1.2" fill="none" opacity="0.65" />
        </svg>
      </div>

      {/* Tiny moon — mid-left */}
      <div className="planet hidden md:block" style={{ top: "26%", left: "7%", opacity: 0.14, animationDelay: "6s" }}>
        <svg width="30" height="30" viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="13" fill="rgba(56,189,248,0.06)" stroke="#38bdf8" strokeWidth="1.8" />
          <circle cx="16" cy="17" r="2.2" stroke="#5cc0e6" strokeWidth="1" fill="none" opacity="0.6" />
        </svg>
      </div>
    </div>
  );
}
