/**
 * Configurable keyboard shortcuts. A combination is stored as text such as
 * "Ctrl+Shift+F" or "/" (modifiers in the order Ctrl, Alt, Shift; Cmd counts
 * as Ctrl). Only changed shortcuts are saved; the rest use the defaults.
 */
import { t, type MessageKey } from "./i18n";

export type ShortcutAction =
  | "search"
  | "bookmarks"
  | "toggleBookmark"
  | "palette"
  | "contextMenu"
  | "settings"
  | "announceLocation"
  | "editLocation";

/** In the order the settings list shows them. */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  search: "Ctrl+F",
  bookmarks: "Ctrl+B",
  toggleBookmark: "Ctrl+D",
  palette: "Ctrl+K",
  contextMenu: "Shift+F10",
  settings: "Ctrl+S",
  announceLocation: "Ctrl+L",
  editLocation: "/",
};

export const SHORTCUT_ACTIONS = Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[];

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock"]);
/** Kept for typing in text fields, whatever the user binds. */
const TEXT_EDITING = new Set(["Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Y", "Ctrl+Z"]);

/** The combination an event stands for, or null for a lone modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // Shift is part of a printable character already ("?" is Shift+ß on some layouts).
  const shiftCounts = e.key.length > 1 || /[a-z]/i.test(e.key);
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && shiftCounts) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/**
 * Why a combination cannot be used, or null if it can. Without Ctrl or Alt
 * only function keys and "/" are allowed: plain keys move, type and jump.
 */
export function whyNotAllowed(combo: string): MessageKey | null {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const hasCommand = parts.includes("Ctrl") || parts.includes("Alt");
  if (TEXT_EDITING.has(combo)) return "settings.reservedEditing";
  if (!hasCommand && !/^F\d{1,2}$/.test(key) && combo !== "/") return "settings.reservedPlain";
  return null;
}

/** True when the combination should not fire while typing in a text field. */
export function isPlainKey(combo: string): boolean {
  return !combo.includes("Ctrl+") && !combo.includes("Alt+");
}

/** Localized display form, e.g. "Strg+Umschalt+F". */
export function formatCombo(combo: string): string {
  const names: Record<string, MessageKey> = {
    Ctrl: "key.ctrl",
    Alt: "key.alt",
    Shift: "key.shift",
    Space: "key.space",
  };
  return combo
    .split("+")
    .map((part) => (names[part] ? t(names[part]) : part))
    .join("+");
}

export class Shortcuts {
  private overrides: Partial<Record<ShortcutAction, string>> = {};

  /** Loads saved overrides, ignoring unknown actions. */
  load(saved: Record<string, string>): void {
    this.overrides = {};
    for (const action of SHORTCUT_ACTIONS) {
      if (saved[action]) this.overrides[action] = saved[action];
    }
  }

  /** The overrides to save. */
  get saved(): Record<string, string> {
    return { ...this.overrides };
  }

  get(action: ShortcutAction): string {
    return this.overrides[action] ?? DEFAULT_SHORTCUTS[action];
  }

  defaultFor(action: ShortcutAction): string {
    return DEFAULT_SHORTCUTS[action];
  }

  isDefault(action: ShortcutAction): boolean {
    return this.get(action) === DEFAULT_SHORTCUTS[action];
  }

  set(action: ShortcutAction, combo: string): void {
    if (combo === DEFAULT_SHORTCUTS[action]) delete this.overrides[action];
    else this.overrides[action] = combo;
  }

  resetAll(): void {
    this.overrides = {};
  }

  /** The action bound to `combo`, if any. */
  actionFor(combo: string): ShortcutAction | null {
    return SHORTCUT_ACTIONS.find((action) => this.get(action) === combo) ?? null;
  }
}
