import type { ReactNode } from "react";

const PLANE = "M32 10 L36 28 L54 36 L54 40 L36 36 L35 48 L41 52 L41 55 L32 52 L23 55 L23 52 L29 48 L28 36 L10 40 L10 36 L28 28 Z";

function Svg({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const IconFlight = () => (
  <svg viewBox="0 0 64 64" aria-hidden="true" fill="currentColor">
    <path d={PLANE} transform="rotate(45 32 32) scale(1.08) translate(-2.5 -2.5)" />
  </svg>
);
export const IconCockpit = () => (
  <Svg>
    <path d="M5 7h14M5 12h14M5 17h14" />
    <circle cx="9" cy="7" r="2" fill="currentColor" />
    <circle cx="15" cy="12" r="2" fill="currentColor" />
    <circle cx="8" cy="17" r="2" fill="currentColor" />
  </Svg>
);
export const IconComms = () => (
  <Svg>
    <path d="M4 5.5h16v11H10l-4.5 3.5v-3.5H4z" />
    <path d="M8 10h8M8 13h5" />
  </Svg>
);
export const IconMap = () => (
  <Svg>
    <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z" />
    <path d="M9 4v14M15 6v14" />
  </Svg>
);
export const IconLanding = () => (
  <Svg>
    <path d="M12 3.5v10m0 0-4-4m4 4 4-4" />
    <path d="M3.5 20.5h17" />
    <path d="M7 17h2M11 17h2M15 17h2" />
  </Svg>
);
export const IconSun = () => (
  <Svg>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
  </Svg>
);
export const IconMoon = () => (
  <Svg>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
  </Svg>
);
export const IconAuto = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" />
  </Svg>
);

/** The app mark: a plane on a burgundy tile. */
export const BrandMark = () => (
  <svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true">
    <rect width="64" height="64" rx="15" fill="rgba(255,255,255,0.14)" />
    <path d={PLANE} fill="#fff" transform="translate(0 1)" />
  </svg>
);

export const IconBrief = () => (
  <Svg>
    <path d="M6 3.5h8l4 4v13H6z" />
    <path d="M14 3.5v4h4M9 12h6M9 15.5h6" />
  </Svg>
);

export const IconSystems = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9L18 18M18 6l-2.1 2.1M8.1 15.9L6 18" />
  </Svg>
);

/* ---- shell icons ---- */
export const IconChip = () => (
  <Svg>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
    <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
  </Svg>
);
export const IconInbox = () => (
  <Svg>
    <path d="M3.5 13.5l2.5-7h12l2.5 7v5h-17z" />
    <path d="M3.5 13.5h5l1 2.5h5l1-2.5h5" />
  </Svg>
);
export const IconAtlas = () => (
  <Svg>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <circle cx="9" cy="11" r="2" />
    <path d="M5.8 16c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M14 10h4M14 13.5h4" />
  </Svg>
);
export const IconSearch = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Svg>
);
export const IconGlobe = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.5 2.4 3.6 5.2 3.6 8.5s-1.1 6.100-3.600 8.500c-2.500-2.400-3.600-5.200-3.600-8.500S9.500 5.900 12 3.500z" />
  </Svg>
);
export const IconBroadcast = () => (
  <Svg>
    <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    <path d="M8.600 8.600a4.800 4.800 0 000 6.800M15.400 8.600a4.800 4.800 0 010 6.800M5.800 5.800a8.800 8.800 0 000 12.400M18.200 5.800a8.800 8.800 0 010 12.400" />
  </Svg>
);
export const IconLayers = () => (
  <Svg>
    <path d="M12 3.500l8.500 4.500-8.500 4.500L3.500 8z" />
    <path d="M3.500 12l8.500 4.500 8.500-4.500M3.500 16l8.500 4.500 8.500-4.500" />
  </Svg>
);
export const IconLocate = ({ on }: { on?: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
    <path d="M20 4L4 10.500l6.200 2.300L12.500 20z" />
  </svg>
);
export const IconRefresh = () => (
  <Svg>
    <path d="M19.500 12a7.500 7.500 0 11-2.300-5.400M19.500 4.500v4h-4" />
  </Svg>
);
export const IconPlus = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.500" />
    <path d="M12 8v8M8 12h8" />
  </Svg>
);
export const IconClose = () => (
  <Svg>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
