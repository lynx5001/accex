/**
 * Bookmarks popup: a focused listbox. Arrows move, Enter opens the
 * location, Delete removes the bookmark, Escape dismisses.
 */
import type { Bookmark } from "../../bridge/types";
import { closePopup, openPopup, registerPopup } from "../../accessibility/focus-manager";
import { t } from "../../i18n";

export interface BookmarksContext {
  restoreFallback: () => void;
  onGo(bookmark: Bookmark): void;
  onRemove(bookmark: Bookmark): Promise<void>;
}

export class BookmarksPopup {
  private bookmarks: Bookmark[] = [];
  private active = 0;
  private ctx: BookmarksContext | null = null;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly list: HTMLUListElement,
  ) {
    registerPopup(dialog);
    list.setAttribute("aria-label", t("bookmarks.listLabel"));
    list.addEventListener("keydown", (e) => this.onKeyDown(e));
    list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
      if (li?.dataset.index) this.go(Number(li.dataset.index));
    });
  }

  open(bookmarks: Bookmark[], ctx: BookmarksContext): void {
    this.bookmarks = bookmarks;
    this.ctx = ctx;
    this.active = 0;
    this.render();
    openPopup(this.dialog, { initialFocus: this.list, restoreFallback: ctx.restoreFallback });
  }

  private render(): void {
    const items = this.bookmarks.map((b, i) => {
      const li = document.createElement("li");
      li.id = `bookmark-${i}`;
      li.setAttribute("role", "option");
      li.dataset.index = String(i);
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = b.name;
      const path = document.createElement("span");
      path.className = "row-meta";
      path.textContent = b.path;
      li.append(name, path);
      li.setAttribute("aria-label", `${b.name}, ${b.path}`);
      return li;
    });
    if (!items.length) {
      const li = document.createElement("li");
      li.id = "bookmark-empty";
      li.setAttribute("role", "option");
      li.setAttribute("aria-disabled", "true");
      li.textContent = t("bookmarks.empty");
      items.push(li);
    }
    this.list.replaceChildren(...items);
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

  private go(index: number): void {
    const bookmark = this.bookmarks[index];
    if (!bookmark) return;
    closePopup(this.dialog, false);
    this.ctx?.onGo(bookmark);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const n = this.bookmarks.length;
    switch (e.key) {
      case "ArrowDown":
        if (n) this.active = (this.active + 1) % n;
        break;
      case "ArrowUp":
        if (n) this.active = (this.active - 1 + n) % n;
        break;
      case "Home":
        this.active = 0;
        break;
      case "End":
        this.active = Math.max(0, n - 1);
        break;
      case "Enter":
        this.go(this.active);
        return;
      case "Delete": {
        const bookmark = this.bookmarks[this.active];
        if (!bookmark || !this.ctx) return;
        void this.ctx.onRemove(bookmark).then(() => {
          this.bookmarks.splice(this.active, 1);
          this.active = Math.min(this.active, Math.max(0, this.bookmarks.length - 1));
          this.render();
        });
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    this.sync();
  }
}
