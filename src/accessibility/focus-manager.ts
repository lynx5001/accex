/**
 * Popup focus handling: every popup is a native modal `<dialog>` (which
 * traps focus and hides the background from assistive tech). Opening one
 * moves focus inside; closing it restores focus to where the user was.
 *
 * Popups share one placement: as wide as the path bar and lined up with
 * it, in the top fifth of the window (see `setPopupAnchor`). A popup opened
 * `at` a point (the context menu) sits there instead, kept on screen.
 */

interface OpenPopup {
  dialog: HTMLDialogElement;
  returnTo: HTMLElement | null;
  fallback: () => void;
  onClose?: () => void;
  /** Placed at a point instead of along the path bar. */
  pinned: boolean;
}

const stack: OpenPopup[] = [];
let anchor: HTMLElement | null = null;

/** Sets the element (the path bar) whose width and position popups take. */
export function setPopupAnchor(element: HTMLElement): void {
  anchor = element;
}

/** Lines `dialog` up with the anchor, in the top fifth but never over it. */
function place(dialog: HTMLDialogElement): void {
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const top = Math.max(rect.bottom + 8, window.innerHeight / 10);
  dialog.style.left = `${rect.left}px`;
  dialog.style.top = `${Math.round(top)}px`;
  dialog.style.width = `${rect.width}px`;
}

/**
 * Puts `dialog` at a viewport point. Without room below, it opens upwards,
 * ending at `at.above` (the top of the row it belongs to); it always stays
 * inside the window.
 */
function placeAt(dialog: HTMLDialogElement, at: PopupPoint): void {
  const margin = 8;
  const { width, height } = dialog.getBoundingClientRect();
  const fitsBelow = at.y + height <= window.innerHeight - margin;
  const y = fitsBelow ? at.y : (at.above ?? at.y) - height;
  dialog.style.width = "";
  dialog.style.left = `${Math.max(margin, Math.min(at.x, window.innerWidth - width - margin))}px`;
  dialog.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - height - margin))}px`;
}

function placeAll(): void {
  for (const popup of stack) if (!popup.pinned) place(popup.dialog);
}

export interface PopupPoint {
  x: number;
  y: number;
  /** Where the popup ends when it opens upwards (default: `y`). */
  above?: number;
}

export interface PopupOptions {
  /** Element that receives focus once the popup is open. */
  initialFocus: HTMLElement;
  /** Used when the previously focused element no longer exists. */
  restoreFallback: () => void;
  /** Called after the popup closed (by Escape or programmatically). */
  onClose?: () => void;
  /** Viewport point to open at (top-left corner), instead of the path bar. */
  at?: PopupPoint;
}

/** True while any popup is open; global shortcuts are suspended then. */
export function isPopupOpen(): boolean {
  return stack.length > 0;
}

/** The popup on top, if any. */
export function topPopup(): HTMLDialogElement | null {
  return stack[stack.length - 1]?.dialog ?? null;
}

export function openPopup(dialog: HTMLDialogElement, options: PopupOptions): void {
  if (dialog.open) return;
  const active = document.activeElement;
  stack.push({
    dialog,
    returnTo: active instanceof HTMLElement ? active : null,
    fallback: options.restoreFallback,
    onClose: options.onClose,
    pinned: options.at !== undefined,
  });
  if (!options.at) place(dialog);
  if (stack.length === 1) window.addEventListener("resize", placeAll);
  dialog.showModal();
  // Measured once open, so the point can be clamped to the popup's real size.
  if (options.at) placeAt(dialog, options.at);
  options.initialFocus.focus();
}

/**
 * Closes `dialog` and restores focus. `restore: false` skips the focus
 * restoration when the caller is about to move focus itself (e.g. after
 * navigating to a bookmark).
 */
export function closePopup(dialog: HTMLDialogElement, restore = true): void {
  const i = stack.findIndex((p) => p.dialog === dialog);
  if (i === -1) return;
  const [popup] = stack.splice(i, 1);
  if (!stack.length) window.removeEventListener("resize", placeAll);
  if (dialog.open) dialog.close();
  if (restore) {
    if (popup.returnTo?.isConnected) popup.returnTo.focus();
    else popup.fallback();
  }
  popup.onClose?.();
}

/**
 * Wires Escape to `closePopup`. The key is caught in the capture phase:
 * WebKit lets a `type="search"` input swallow Escape (to clear itself), so
 * the dialog's `cancel` event alone is not enough. `cancel` stays as a
 * fallback, and `close` keeps the stack right if the dialog closes any
 * other way.
 */
export function registerPopup(dialog: HTMLDialogElement): void {
  dialog.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closePopup(dialog);
    },
    { capture: true },
  );
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closePopup(dialog);
  });
  dialog.addEventListener("close", () => closePopup(dialog));
}

/** Closes every open popup without restoring focus (teardown). */
export function closeAllPopups(): void {
  while (stack.length) closePopup(stack[stack.length - 1].dialog, false);
}
