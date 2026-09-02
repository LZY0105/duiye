// UI — double-tap, detected from pointer events.
//
// NOT `dblclick`. That is a mouse event, and on a tablet it exists only if the
// browser chooses to synthesise it from a double-tap — which it declines to do
// on a page it considers zoomable, and delays by up to 300ms when it does. A
// pointer-based detector behaves the same for stylus, finger and mouse, which
// is the whole point on a device where all three are in use.
//
// The thresholds are the platform's own: 400ms between taps, and a radius wide
// enough to absorb the hand's wobble between two taps with a pen.

const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_SLOP = 28;

/**
 * Calls `handler` when an element is tapped twice in quick succession.
 *
 * @param {HTMLElement} el
 * @param {function(PointerEvent): void} handler
 * @param {{ignore?: string, windowMs?: number, slop?: number}} [opts]
 *   `ignore` is a selector for descendants that speak for themselves — a tap
 *   that lands on one of those is a tap on IT, not on the element around it.
 * @returns {function(): void} removes the listener
 */
export function onDoubleTap(el, handler, opts = {}) {
  const {
    ignore = null,
    windowMs = DOUBLE_TAP_MS,
    slop = DOUBLE_TAP_SLOP,
  } = opts;
  if (!el || typeof handler !== 'function') return () => {};

  let lastAt = 0;
  let lastX = 0;
  let lastY = 0;

  const onUp = (e) => {
    if (ignore && e.target?.closest?.(ignore)) return;

    const now = Date.now();
    const near = Math.hypot(e.clientX - lastX, e.clientY - lastY) <= slop;
    if (lastAt && now - lastAt <= windowMs && near) {
      // Consumed, so a third tap starts a new pair rather than firing again.
      lastAt = 0;
      handler(e);
      return;
    }
    lastAt = now;
    lastX = e.clientX;
    lastY = e.clientY;
  };

  el.addEventListener('pointerup', onUp);
  return () => el.removeEventListener('pointerup', onUp);
}
