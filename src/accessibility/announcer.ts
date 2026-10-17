/**
 * Screen reader announcements through ARIA live regions. The app never
 * produces speech itself; it only updates these regions.
 *
 * - `announce()` → `role="status"` / `aria-live="polite"` (feedback, counts)
 * - `announceError()` → `role="alert"` / `aria-live="assertive"` (errors only)
 */

let politeRegion: HTMLElement | null = null;
let assertiveRegion: HTMLElement | null = null;
let politeTimer: number | undefined;
let assertiveTimer: number | undefined;

export function initAnnouncer(polite: HTMLElement, assertive: HTMLElement): void {
  politeRegion = polite;
  assertiveRegion = assertive;
}

/**
 * Clearing first and writing on the next frame makes screen readers repeat
 * identical consecutive messages (e.g. pressing Ctrl+L twice).
 */
function write(region: HTMLElement | null, message: string, timer: number | undefined): number {
  if (!region) return 0;
  window.clearTimeout(timer);
  region.textContent = "";
  return window.setTimeout(() => {
    region.textContent = message;
  }, 50);
}

export function announce(message: string): void {
  politeTimer = write(politeRegion, message, politeTimer);
}

export function announceError(message: string): void {
  assertiveTimer = write(assertiveRegion, message, assertiveTimer);
}
