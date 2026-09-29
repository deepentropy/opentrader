/*
 * TV's chart mouse-wheel helper (main_chart module 879505, class `ye` + its
 * normalizer `fe`, read 27/09/2026 from TV Desktop 3.4.1).
 *
 *  - Outside macOS, Shift swaps the axes (vertical wheel → horizontal move):
 *    deltaX = -deltaY, deltaY = deltaX. macOS swaps natively.
 *  - Deltas are summed over a burst (reset after 100 ms without events); when
 *    one axis is >= 3x the other, the weaker axis is dropped.
 *  - Normalized: / 100, then x32 for DOM_DELTA_LINE, x120 for DOM_DELTA_PAGE.
 */
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

export class WheelHelper {
  private totalX = 0;
  private totalY = 0;
  private prevTime = 0;

  process(e: WheelEvent): { deltaX: number; deltaY: number } {
    if (e.timeStamp - this.prevTime > 100) {
      this.totalX = 0;
      this.totalY = 0;
    }
    const swap = !IS_MAC && e.shiftKey;
    const dx = swap ? -e.deltaY : e.deltaX;
    const dy = swap ? e.deltaX : e.deltaY;
    this.totalX += dx;
    this.totalY += dy;
    this.prevTime = e.timeStamp;
    let x = dx;
    let y = dy;
    if (this.totalX !== 0 && this.totalY !== 0) {
      if (Math.abs(this.totalX) >= Math.abs(3 * this.totalY)) y = 0;
      if (Math.abs(this.totalY) >= Math.abs(3 * this.totalX)) x = 0;
    }
    x /= 100;
    y /= 100;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      x *= 120;
      y *= 120;
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      x *= 32;
      y *= 32;
    }
    return { deltaX: x, deltaY: y };
  }
}
