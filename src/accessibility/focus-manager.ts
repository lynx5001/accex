/**
 * Popup focus handling: every popup is a native modal `<dialog>` (which
 * traps focus and hides the background from assistive tech). Opening one
 * moves focus inside; closing it restores focus to where the user was.
 */

interface OpenPopup {
  dialog: HTMLDialogElement;
  returnTo: HTMLElement | null;
  fallback: () => void;
  onClose?: () => void;
}

const stack: OpenPopup[] = [];

export interface PopupOptions {
  /** Element that receives focus once the popup is open. */
  initialFocus: HTMLElement;
  /** Used when the previously focused element no longer exists. */
  restoreFallback: () => void;
  /** Called after the popup closed (by Escape or programmatically). */
  onClose?: () => void;
}

/** True while any popup is open; global shortcuts are suspended then. */
export function isPopupOpen(): boolean {
  return stack.length > 0;
}

export function openPopup(dialog: HTMLDialogElement, options: PopupOptions): void {
  if (dialog.open) return;
  const active = document.activeElement;
  stack.push({
    dialog,
    returnTo: active instanceof HTMLElement ? active : null,
    fallback: options.restoreFallback,
    onClose: options.onClose,
  });
  dialog.showModal();
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
