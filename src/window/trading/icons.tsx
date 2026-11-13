/*
 * Small line icons of the trading UI (drawn here, 18 px grid unless noted).
 */
export const CloseIcon = (p: { size?: number }) => (
  <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke-linecap="round" />
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

export const PencilIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="none" stroke="currentColor" d="M3.5 14.5 4 11l8-8 3 3-8 8-3.5.5ZM10.5 4.5l3 3" />
  </svg>
);
