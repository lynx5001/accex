/**
 * Context menu as a command palette (combobox + listbox).
 *
 * - Focus jumps to the text input; typing filters suggestions live.
 * - Arrow Down on an empty input lists every operation (discoverability).
 * - Enter runs the highlighted suggestion (or the first match).
 * - Rename switches the same input into a "new name" prompt.
 * - Escape dismisses without action.
 */
import type { OperationType } from "../../bridge/types";
import { announce } from "../../accessibility/announcer";
import { closePopup, openPopup, registerPopup } from "../../accessibility/focus-manager";
import { t, type MessageKey } from "../../i18n";

/** Alias words that match regardless of the UI language. */
const ALIASES: Record<OperationType, string[]> = {
  open: ["open", "öffnen"],
  copy: ["copy", "kopieren"],
  cut: ["cut", "move", "ausschneiden", "verschieben"],
  paste: ["paste", "einfügen"],
  delete: ["delete", "remove", "trash", "löschen", "entfernen"],
  rename: ["rename", "umbenennen"],
  bookmark: ["bookmark", "favorite", "lesezeichen"],
};

const ORDER: OperationType[] = ["open", "copy", "cut", "paste", "delete", "rename", "bookmark"];

export interface PaletteContext {
  /** Name of the focused item, if any. */
  targetName: string | null;
  /** Operations that make sense right now. */
  available: OperationType[];
  restoreFallback: () => void;
  /** Runs an operation; `newName` is set for rename. */
  onRun(op: OperationType, newName?: string): void;
}

export class CommandPalette {
  private ctx: PaletteContext | null = null;
  private matches: OperationType[] = [];
  private active = -1;
  private renaming = false;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly input: HTMLInputElement,
    private readonly list: HTMLUListElement,
  ) {
    registerPopup(dialog);
    list.setAttribute("aria-label", t("palette.listLabel"));
    input.addEventListener("input", () => {
      if (!this.renaming) this.update(false);
    });
    input.addEventListener("keydown", (e) => this.onKeyDown(e));
    list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
      if (li?.dataset.op) this.run(li.dataset.op as OperationType);
    });
  }

  open(ctx: PaletteContext): void {
    this.ctx = ctx;
    this.renaming = false;
    this.input.value = "";
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute(
      "aria-label",
      ctx.targetName
        ? t("palette.inputLabel", { name: ctx.targetName })
        : t("palette.inputLabelNoTarget"),
    );
    this.hideList();
    openPopup(this.dialog, { initialFocus: this.input, restoreFallback: ctx.restoreFallback });
  }

  private label(op: OperationType): string {
    return t(`op.${op}` as MessageKey);
  }

  private filter(text: string): OperationType[] {
    const q = text.trim().toLowerCase();
    const ops = ORDER.filter((op) => this.ctx?.available.includes(op));
    if (!q) return ops;
    return ops.filter(
      (op) => this.label(op).toLowerCase().includes(q) || ALIASES[op].some((a) => a.startsWith(q)),
    );
  }

  /** Recomputes suggestions. `showAll` lists everything for an empty input. */
  private update(showAll: boolean): void {
    const text = this.input.value;
    if (!text.trim() && !showAll) {
      this.hideList();
      return;
    }
    this.matches = this.filter(text);
    this.active = showAll && this.matches.length ? 0 : -1;
    this.renderList();
    announce(
      this.matches.length
        ? t("palette.suggestions", { count: this.matches.length })
        : t("palette.noMatch"),
    );
  }

  private renderList(): void {
    const items = this.matches.map((op, i) => {
      const li = document.createElement("li");
      li.id = `palette-option-${op}`;
      li.setAttribute("role", "option");
      li.dataset.op = op;
      li.textContent = this.label(op);
      li.setAttribute("aria-selected", String(i === this.active));
      return li;
    });
    if (!items.length) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-disabled", "true");
      li.textContent = t("palette.noMatch");
      items.push(li);
    }
    this.list.replaceChildren(...items);
    this.list.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.syncActive();
  }

  private hideList(): void {
    this.matches = [];
    this.active = -1;
    this.list.hidden = true;
    this.list.replaceChildren();
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }

  private syncActive(): void {
    this.list.querySelectorAll<HTMLElement>("[role=option]").forEach((li, i) => {
      li.setAttribute("aria-selected", String(i === this.active));
    });
    const op = this.matches[this.active];
    if (op) {
      this.input.setAttribute("aria-activedescendant", `palette-option-${op}`);
      document.getElementById(`palette-option-${op}`)?.scrollIntoView({ block: "nearest" });
    } else {
      this.input.removeAttribute("aria-activedescendant");
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.renaming) {
      if (e.key === "Enter") {
        e.preventDefault();
        const name = this.input.value.trim();
        if (name) this.finish("rename", name);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        if (this.list.hidden) {
          this.update(true);
        } else if (this.matches.length) {
          this.active = (this.active + 1) % this.matches.length;
          this.syncActive();
        }
        break;
      case "ArrowUp":
        if (this.matches.length) {
          this.active = this.active <= 0 ? this.matches.length - 1 : this.active - 1;
          this.syncActive();
        }
        break;
      case "Enter": {
        // Empty input and nothing highlighted: nothing to run.
        if (!this.input.value.trim() && this.active < 0) break;
        const op = this.matches[this.active] ?? this.filter(this.input.value)[0];
        if (op) this.run(op);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  private run(op: OperationType): void {
    if (op === "rename") {
      this.startRename();
      return;
    }
    this.finish(op);
  }

  private startRename(): void {
    const name = this.ctx?.targetName ?? "";
    this.renaming = true;
    this.hideList();
    this.input.setAttribute("role", "textbox");
    this.input.removeAttribute("aria-expanded");
    this.input.setAttribute("aria-label", t("palette.renameLabel", { name }));
    this.input.value = name;
    // Pre-select the stem so typing replaces the name but keeps the extension.
    const dot = name.lastIndexOf(".");
    this.input.setSelectionRange(0, dot > 0 ? dot : name.length);
    // Re-focusing makes screen readers announce the new label.
    this.input.blur();
    this.input.focus();
  }

  private finish(op: OperationType, newName?: string): void {
    const ctx = this.ctx;
    closePopup(this.dialog);
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-expanded", "false");
    ctx?.onRun(op, newName);
  }
}
