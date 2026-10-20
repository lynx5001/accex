/**
 * Context menu: `role="menu"` in a modal dialog, opened at the pointer
 * (right click) or at the focused row (Menu key, Shift+F10). Focus moves
 * onto the items (roving tabindex): Up/Down/Home/End move, Enter/Space run,
 * Escape closes and restores focus. Each item has a fixed key that jumps to
 * it in any language (C copy, X cut, V paste, as with Ctrl+C/X/V).
 */
import type { OperationType } from "../../bridge/types";
import {
  closePopup,
  openPopup,
  registerPopup,
  type PopupPoint,
} from "../../accessibility/focus-manager";
import { t, type MessageKey } from "../../i18n";

/** Item order; `null` draws a separator. */
const ITEMS: (OperationType | null)[] = [
  "open",
  null,
  "cut",
  "copy",
  "paste",
  null,
  "rename",
  "delete",
];

/** Jump keys, shown next to each item and exposed as `aria-keyshortcuts`. */
const KEYS: Partial<Record<OperationType, string>> = {
  open: "o",
  cut: "x",
  copy: "c",
  paste: "v",
  rename: "r",
  delete: "d",
};

export interface ContextMenuContext {
  /** Viewport point for the menu's top-left corner. */
  at: PopupPoint;
  /** Name of the file or folder the menu acts on, if any. */
  targetName: string | null;
  /** Operations that make sense right now; the others are shown disabled. */
  available: OperationType[];
  restoreFallback: () => void;
  onRun(op: OperationType): void;
}

export class ContextMenu {
  private ctx: ContextMenuContext | null = null;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly menu: HTMLUListElement,
  ) {
    registerPopup(dialog);
    menu.addEventListener("keydown", (e) => this.onKeyDown(e));
    menu.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[role=menuitem]");
      if (item) this.run(item);
    });
    // A click on the backdrop (outside the menu) closes it, as menus do.
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) closePopup(dialog);
    });
  }

  open(ctx: ContextMenuContext): void {
    this.ctx = ctx;
    this.menu.setAttribute(
      "aria-label",
      ctx.targetName ? t("menu.label", { name: ctx.targetName }) : t("menu.labelNoTarget"),
    );
    this.menu.replaceChildren(
      ...ITEMS.map((op) => {
        const li = document.createElement("li");
        if (!op) {
          li.setAttribute("role", "separator");
          return li;
        }
        li.setAttribute("role", "menuitem");
        li.id = `menu-item-${op}`;
        li.dataset.op = op;
        li.tabIndex = -1;
        const label = t(`op.${op}` as MessageKey);
        li.textContent = label;
        // The key is drawn from data-key by CSS; the label keeps it out of the name.
        li.setAttribute("aria-label", label);
        const key = KEYS[op];
        if (key) {
          li.dataset.key = key.toUpperCase();
          li.setAttribute("aria-keyshortcuts", key.toUpperCase());
        }
        if (!ctx.available.includes(op)) li.setAttribute("aria-disabled", "true");
        return li;
      }),
    );
    const first = this.items().find((i) => i.getAttribute("aria-disabled") !== "true");
    openPopup(this.dialog, {
      initialFocus: first ?? this.menu,
      restoreFallback: ctx.restoreFallback,
      at: ctx.at,
    });
  }

  private items(): HTMLElement[] {
    return Array.from(this.menu.querySelectorAll<HTMLElement>("[role=menuitem]"));
  }

  private run(item: HTMLElement): void {
    if (item.getAttribute("aria-disabled") === "true") return;
    const ctx = this.ctx;
    closePopup(this.dialog);
    ctx?.onRun(item.dataset.op as OperationType);
  }

  /** Moves focus `step` items on (wrapping), or to `index` when given. */
  private move(step: number, index?: number): void {
    const items = this.items();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = index ?? (current + step + items.length) % items.length;
    items[next]?.focus();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const items = this.items();
    switch (e.key) {
      case "ArrowDown":
        this.move(1);
        break;
      case "ArrowUp":
        this.move(-1);
        break;
      case "Home":
        this.move(0, 0);
        break;
      case "End":
        this.move(0, items.length - 1);
        break;
      case "Enter":
      case " ":
        if (document.activeElement instanceof HTMLElement) this.run(document.activeElement);
        break;
      case "Tab":
        // Menus have no Tab stops; Tab leaves the menu like Escape.
        closePopup(this.dialog);
        break;
      default: {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const letter = e.key.toLowerCase();
        const match = items.findIndex((i) => KEYS[i.dataset.op as OperationType] === letter);
        if (match < 0) return;
        this.move(0, match);
      }
    }
    e.preventDefault();
  }
}
