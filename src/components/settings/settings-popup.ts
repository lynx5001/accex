/**
 * Settings popup, built like the bookmarks popup: a focused listbox under a
 * title. It shows the settings categories first; Enter opens one.
 *
 * Keyboard shortcuts: one option per action with its combination, and
 * "Reset all shortcuts" at the bottom. Enter records a new combination
 * (Escape cancels the recording), Delete resets one shortcut, Backspace or
 * Left goes back to the categories, Escape closes the popup.
 */
import { announce, announceError } from "../../accessibility/announcer";
import { openPopup, registerPopup } from "../../accessibility/focus-manager";
import { t, type MessageKey } from "../../i18n";
import {
  comboFromEvent,
  formatCombo,
  SHORTCUT_ACTIONS,
  whyNotAllowed,
  type ShortcutAction,
  type Shortcuts,
} from "../../shortcuts";

type View = "categories" | "shortcuts";

/** One option of the current view. */
type Entry =
  | { type: "category"; id: "shortcuts" }
  | { type: "shortcut"; action: ShortcutAction }
  | { type: "resetAll" };

export interface SettingsContext {
  shortcuts: Shortcuts;
  restoreFallback: () => void;
  /** Persists the shortcuts after a change. */
  onChange(): Promise<void>;
}

export class SettingsPopup {
  private ctx: SettingsContext | null = null;
  private view: View = "categories";
  private entries: Entry[] = [];
  private active = 0;
  /** The action whose new combination is being recorded. */
  private recording: ShortcutAction | null = null;
  private readonly recorder = (e: KeyboardEvent) => this.onRecordKey(e);

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly title: HTMLElement,
    private readonly list: HTMLUListElement,
  ) {
    registerPopup(dialog);
    list.addEventListener("keydown", (e) => this.onKeyDown(e));
    list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
      if (!li?.dataset.index) return;
      this.active = Number(li.dataset.index);
      this.choose();
    });
    dialog.addEventListener("close", () => this.stopRecording());
  }

  open(ctx: SettingsContext): void {
    this.ctx = ctx;
    this.show("categories", 0);
    openPopup(this.dialog, { initialFocus: this.list, restoreFallback: ctx.restoreFallback });
  }

  private show(view: View, active: number): void {
    this.view = view;
    this.active = active;
    this.entries =
      view === "categories"
        ? [{ type: "category", id: "shortcuts" }]
        : [
            ...SHORTCUT_ACTIONS.map((action): Entry => ({ type: "shortcut", action })),
            { type: "resetAll" },
          ];
    this.title.textContent = t(
      view === "categories" ? "settings.dialogLabel" : "settings.shortcuts",
    );
    this.list.setAttribute(
      "aria-label",
      t(view === "categories" ? "settings.listLabel" : "settings.shortcutsLabel"),
    );
    this.render();
  }

  private render(): void {
    const shortcuts = this.ctx?.shortcuts;
    this.list.replaceChildren(
      ...this.entries.map((entry, i) => {
        const li = document.createElement("li");
        li.id = `setting-${i}`;
        li.setAttribute("role", "option");
        li.dataset.index = String(i);
        const name = document.createElement("span");
        name.className = "row-name";
        li.append(name);
        if (entry.type === "category") {
          name.textContent = t("settings.shortcuts");
          li.setAttribute("aria-label", name.textContent);
        } else if (entry.type === "resetAll") {
          li.classList.add("reset-all");
          name.textContent = t("settings.resetAll");
          li.setAttribute("aria-label", name.textContent);
        } else if (shortcuts) {
          name.textContent = t(`shortcut.${entry.action}` as MessageKey);
          const combo = document.createElement("span");
          combo.className = "row-meta setting-combo";
          const recording = this.recording === entry.action;
          combo.textContent = recording
            ? t("settings.pressKeys")
            : formatCombo(shortcuts.get(entry.action));
          li.classList.toggle("recording", recording);
          li.append(combo);
          li.setAttribute("aria-label", `${name.textContent}, ${combo.textContent}`);
        }
        return li;
      }),
    );
    this.sync();
  }

  private sync(): void {
    const options = this.list.querySelectorAll<HTMLElement>("[role=option]");
    options.forEach((li, i) => li.setAttribute("aria-selected", String(i === this.active)));
    const current = options[this.active];
    if (current) {
      this.list.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    }
  }

  /** Re-focusing the list makes screen readers announce the new view. */
  private refocus(): void {
    this.list.blur();
    this.list.focus();
  }

  private choose(): void {
    const entry = this.entries[this.active];
    if (!entry || this.recording) return;
    if (entry.type === "category") {
      this.show("shortcuts", 0);
      this.refocus();
    } else if (entry.type === "shortcut") {
      this.startRecording(entry.action);
    } else {
      void this.resetAll();
    }
  }

  private back(): void {
    if (this.view === "categories") return;
    this.show("categories", 0);
    this.refocus();
  }

  // ------------------------------------------------------------- recording

  private startRecording(action: ShortcutAction): void {
    this.recording = action;
    // Window capture runs before the popup's own Escape handling and the
    // app's shortcuts, so every key reaches the recorder first.
    window.addEventListener("keydown", this.recorder, { capture: true });
    this.render();
    announce(t("settings.recording", { name: t(`shortcut.${action}` as MessageKey) }));
  }

  private stopRecording(): void {
    if (!this.recording) return;
    this.recording = null;
    window.removeEventListener("keydown", this.recorder, { capture: true });
    if (this.dialog.open) this.render();
  }

  private onRecordKey(e: KeyboardEvent): void {
    const action = this.recording;
    const shortcuts = this.ctx?.shortcuts;
    if (!action || !shortcuts) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      this.stopRecording();
      announce(t("settings.cancelled"));
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return; // a lone modifier: keep listening
    const reason = whyNotAllowed(combo);
    if (reason) {
      announceError(t(reason, { combo: formatCombo(combo) }));
      return;
    }
    const owner = shortcuts.actionFor(combo);
    if (owner && owner !== action) {
      announceError(
        t("settings.conflict", {
          combo: formatCombo(combo),
          name: t(`shortcut.${owner}` as MessageKey),
        }),
      );
      return;
    }
    shortcuts.set(action, combo);
    this.stopRecording();
    void this.save(
      t("settings.changed", {
        name: t(`shortcut.${action}` as MessageKey),
        combo: formatCombo(combo),
      }),
    );
  }

  // ----------------------------------------------------------------- reset

  private resetOne(action: ShortcutAction): void {
    const shortcuts = this.ctx?.shortcuts;
    if (!shortcuts || shortcuts.isDefault(action)) return;
    const combo = shortcuts.defaultFor(action);
    const owner = shortcuts.actionFor(combo);
    if (owner) {
      announceError(
        t("settings.conflict", {
          combo: formatCombo(combo),
          name: t(`shortcut.${owner}` as MessageKey),
        }),
      );
      return;
    }
    shortcuts.set(action, combo);
    void this.save(
      t("settings.resetOne", {
        name: t(`shortcut.${action}` as MessageKey),
        combo: formatCombo(shortcuts.get(action)),
      }),
    );
  }

  private async resetAll(): Promise<void> {
    this.ctx?.shortcuts.resetAll();
    await this.save(t("settings.resetAllDone"));
  }

  private async save(message: string): Promise<void> {
    this.render();
    try {
      await this.ctx?.onChange();
      announce(message);
    } catch {
      // onChange announced the error already.
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const n = this.entries.length;
    switch (e.key) {
      case "ArrowDown":
        this.active = (this.active + 1) % n;
        break;
      case "ArrowUp":
        this.active = (this.active - 1 + n) % n;
        break;
      case "Home":
        this.active = 0;
        break;
      case "End":
        this.active = n - 1;
        break;
      case "Enter":
      case " ":
        this.choose();
        return void e.preventDefault();
      case "Backspace":
      case "ArrowLeft":
        this.back();
        return void e.preventDefault();
      case "Delete": {
        const entry = this.entries[this.active];
        if (entry?.type === "shortcut") this.resetOne(entry.action);
        return void e.preventDefault();
      }
      default:
        return;
    }
    e.preventDefault();
    this.sync();
  }
}
