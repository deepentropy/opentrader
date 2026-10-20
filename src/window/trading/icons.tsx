/*
 * Small line icons of the trading UI (drawn here, 18 px grid unless noted).
 */
export const CloseIcon = (p: { size?: number }) => (
  <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke-linecap="round" />
  </svg>
);

export const PencilIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
    <path d="M10.6 2.6l2.8 2.8-7.8 7.8H2.8v-2.8l7.8-7.8z" stroke-linejoin="round" />
    <path d="M9.2 4l2.8 2.8" />
  </svg>
);

export const SearchIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <circle cx="12.5" cy="12.5" r="6.5" />
    <path d="M17.3 17.3L22 22" stroke-linecap="round" />
  </svg>
);

export const CaretIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M4.5 6.5L8 10l3.5-3.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export const ChevronIcon = (p: { open: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"
    style={{ transform: p.open ? "rotate(180deg)" : undefined, transition: "transform .15s" }}>
    <path d="M5 7.5l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export const InfoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle cx="9" cy="9" r="7.5" fill="currentColor" />
    <path d="M9 8v4.5" stroke="#1F1F1F" stroke-width="1.6" stroke-linecap="round" />
    <circle cx="9" cy="5.6" r="1" fill="#1F1F1F" />
  </svg>
);

export const CheckIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M7 13.5l4 4 8-9" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export const AlertIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
    <path d="M13 7.5v7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
    <circle cx="13" cy="18.5" r="1.3" fill="currentColor" />
  </svg>
);

export const NoteIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="8" r="1.3" fill="currentColor" />
    <path d="M13 11.5v7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
  </svg>
);

export const LogOutIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M7 3.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M11.5 6l3 3-3 3M14.5 9H7" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export const PlugIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M9 2.5v4M5 6.5h8v2.5a4 4 0 0 1-8 0V6.5zM9 13v2.5" stroke-linecap="round" />
  </svg>
);

/** The broker's tile mark (no trademark artwork: initials on its colour). */
export const IbkrMark = (p: { size: number; radius?: number }) => (
  <span
    class="trd-broker-mark"
    style={{ width: `${p.size}px`, height: `${p.size}px`, "border-radius": `${p.radius ?? 6}px`, "font-size": `${Math.round(p.size * 0.38)}px` }}
    aria-hidden="true"
  >
    IB
  </span>
);
