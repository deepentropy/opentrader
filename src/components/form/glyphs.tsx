/*
 * Glyphs of the form controls.
 */

/** Check box mark (11×9). */
export const CheckMark = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 9" width="11" height="9" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-width="2" d="M0.999878 4L3.99988 7L9.99988 1" /></svg>
);

/** Filled tick (12 px) of the drawing Settings check boxes. */
export const TickMark = () => (
  <svg viewBox="0 0 16 16" width="12" height="12">
    <path fill="currentColor" d="M14.18 4.18 6 12.36l-4.18-4.18 1.4-1.41L6 9.54l6.77-6.78 1.41 1.42Z" />
  </svg>
);

/** Stroked tick (16 px) of the app Settings check boxes. */
export const StrokeTick = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="2" d="m3.5 8 3 3 6-6.5" />
  </svg>
);

/** Round tick (12 px) of the order ticket menus. */
export const RoundTick = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

/** Select caret / spin arrow (18×18). */
export const Chevron = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg>
);
