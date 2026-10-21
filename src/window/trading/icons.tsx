/*
 * Small line icons of the trading UI (drawn here, 18 px grid unless noted).
 */
export const CloseIcon = (p: { size?: number }) => (
  <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke-linecap="round" />
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

export const ExitIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M7 3.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M11.5 6l3 3-3 3M14.5 9H7" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
