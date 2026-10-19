/**
 * The file list: `role="tree"` with a flat list of `role="treeitem"` rows.
 *
 * Virtualized: only rows in (and near) the viewport exist in the DOM, plus
 * the focused row, which is always kept so focus is never lost. Every row
 * carries `aria-posinset`/`aria-setsize`, so screen readers still report
 * "12 of 10,000". Rows are keyed by path and reused across updates; a
 * background refresh therefore does not move or re-announce focus.
 *
 * Roving tabindex: exactly one row has `tabindex="0"`.
 */
import type { FileEntry } from "../../bridge/types";
import { formatDate, formatShortDate, formatSize, t } from "../../i18n";

export type TreeItem =
  | { type: "entry"; entry: FileEntry; /** Shown for search results. */ location?: string }
  | { type: "more"; label: string }
  | { type: "placeholder"; label: string };

export interface TreeHandlers {
  /** Enter / double click / Right arrow on a folder. */
  onActivate(item: TreeItem, index: number): void;
  /** Left arrow, Backspace, Alt+Up, Cmd+Up. */
  onGoUp(): void;
  /** Escape inside the list. */
  onEscape(): void;
  /** Up arrow on the first row moves to the breadcrumb. */
  onExitTop(): void;
}

const OVERSCAN = 10;
const TYPEAHEAD_RESET_MS = 700;

function keyOf(item: TreeItem): string {
  return item.type === "entry" ? `e:${item.entry.path}` : `${item.type}:${item.label}`;
}

/** Spoken/visible description: type, size, date (and location in search). */
export function describeEntry(entry: FileEntry, location?: string): string {
  const parts: string[] = [];
  if (entry.kind === "directory") parts.push(t("kind.directory"));
  else if (entry.kind === "symlink") parts.push(t("kind.symlink"));
  else if (entry.extension)
    parts.push(t("kind.fileWithExt", { ext: entry.extension.toUpperCase() }));
  else parts.push(t("kind.file"));
  if (entry.size !== null) parts.push(formatSize(entry.size));
  if (entry.modified !== null) parts.push(t("meta.modified", { date: formatDate(entry.modified) }));
  if (location) parts.push(t("meta.in", { path: location }));
  return parts.join(", ");
}

export class FileTree {
  private items: TreeItem[] = [];
  private active = 0;
  private rowHeight = 0;
  private readonly rows = new Map<string, HTMLElement>();
  private readonly rowsHost: HTMLElement;
  private typeahead = "";
  private typeaheadTimer: number | undefined;
  private frame = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: TreeHandlers,
  ) {
    this.rowsHost = root.querySelector<HTMLElement>(".file-list-rows") ?? root;
    root.addEventListener("keydown", (e) => this.onKeyDown(e));
    root.addEventListener("scroll", () => this.scheduleRender(), { passive: true });
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("dblclick", (e) => {
      const index = this.indexFromEvent(e);
      if (index !== null) this.handlers.onActivate(this.items[index], index);
    });
    new ResizeObserver(() => {
      this.rowHeight = 0;
      this.scheduleRender();
    }).observe(root);
  }

  get activeIndex(): number {
    return this.active;
  }

  get activeItem(): TreeItem | undefined {
    return this.items[this.active];
  }

  get length(): number {
    return this.items.length;
  }

  hasFocus(): boolean {
    return this.root.contains(document.activeElement);
  }

  setBusy(busy: boolean): void {
    this.root.setAttribute("aria-busy", String(busy));
  }

  /**
   * Replaces the rows. `focusKey`/`focusIndex` choose the active row;
   * `focus: true` moves keyboard focus to it.
   */
  setItems(
    items: TreeItem[],
    options: { label: string; focusPath?: string; focusIndex?: number; focus?: boolean },
  ): void {
    const hadFocus = this.hasFocus();
    this.items = items;
    this.root.setAttribute("aria-label", options.label);
    this.setBusy(false);

    let index = options.focusIndex ?? 0;
    if (options.focusPath !== undefined) {
      const found = items.findIndex(
        (it) => it.type === "entry" && it.entry.path === options.focusPath,
      );
      if (found >= 0) index = found;
    }
    this.active = Math.max(0, Math.min(items.length - 1, index));
    this.rowsHost.style.height = `${items.length * this.measureRowHeight()}px`;
    this.ensureVisible(this.active);
    this.render();
    // Also refocus when the focused row vanished during a background refresh.
    const focusLost = hadFocus && document.activeElement !== this.rowFor(this.active);
    if (options.focus || focusLost) this.focusActive();
  }

  /** Moves keyboard focus to the active row. */
  focusActive(): void {
    this.render();
    this.rowFor(this.active)?.focus({ preventScroll: true });
  }

  /** Makes `index` the active row and focuses it. */
  focusIndex(index: number): void {
    if (!this.items.length) return;
    this.active = Math.max(0, Math.min(this.items.length - 1, index));
    this.ensureVisible(this.active);
    this.render();
    this.focusActive();
  }

  private rowFor(index: number): HTMLElement | undefined {
    const item = this.items[index];
    return item ? this.rows.get(keyOf(item)) : undefined;
  }

  private measureRowHeight(): number {
    if (this.rowHeight > 0) return this.rowHeight;
    const probe = document.createElement("div");
    probe.className = "tree-row";
    probe.setAttribute("aria-hidden", "true");
    probe.style.visibility = "hidden";
    probe.innerHTML = '<span class="row-name">M</span><span class="row-meta">M</span>';
    this.rowsHost.append(probe);
    this.rowHeight = probe.getBoundingClientRect().height || 40;
    probe.remove();
    return this.rowHeight;
  }

  private ensureVisible(index: number): void {
    const h = this.measureRowHeight();
    const top = index * h;
    const view = this.root.clientHeight;
    if (top < this.root.scrollTop) this.root.scrollTop = top;
    else if (top + h > this.root.scrollTop + view) this.root.scrollTop = top + h - view;
  }

  private scheduleRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.rowsHost.style.height = `${this.items.length * this.measureRowHeight()}px`;
      this.render();
    });
  }

  private render(): void {
    const h = this.measureRowHeight();
    const first = Math.max(0, Math.floor(this.root.scrollTop / h) - OVERSCAN);
    const last = Math.min(
      this.items.length - 1,
      Math.ceil((this.root.scrollTop + this.root.clientHeight) / h) + OVERSCAN,
    );

    const wanted = new Set<number>();
    for (let i = first; i <= last; i++) wanted.add(i);
    if (this.items.length) wanted.add(this.active);

    const keep = new Set<string>();
    for (const i of wanted) {
      const item = this.items[i];
      const key = keyOf(item);
      keep.add(key);
      let row = this.rows.get(key);
      if (!row) {
        row = document.createElement("div");
        row.setAttribute("role", "treeitem");
        row.className = "tree-row";
        this.rows.set(key, row);
        this.rowsHost.append(row);
      }
      this.fillRow(row, item, i, h);
    }
    for (const [key, row] of this.rows) {
      if (!keep.has(key)) {
        row.remove();
        this.rows.delete(key);
      }
    }
  }

  private fillRow(row: HTMLElement, item: TreeItem, index: number, h: number): void {
    const isActive = index === this.active;
    row.id = `tree-row-${index}`;
    row.dataset.index = String(index);
    row.style.transform = `translateY(${index * h}px)`;
    row.tabIndex = isActive ? 0 : -1;
    row.setAttribute("aria-level", "1");
    row.setAttribute("aria-posinset", String(index + 1));
    row.setAttribute("aria-setsize", String(this.items.length));
    row.setAttribute("aria-selected", String(isActive));

    if (item.type === "entry") {
      const { entry } = item;
      const metaId = `tree-row-${index}-meta`;
      row.setAttribute("aria-label", entry.name);
      row.setAttribute("aria-describedby", metaId);
      row.removeAttribute("aria-disabled");
      if (entry.kind === "directory") row.setAttribute("aria-expanded", "false");
      else row.removeAttribute("aria-expanded");
      row.dataset.kind = entry.kind;
      this.setRowContent(row, entry.name, describeEntry(entry, item.location), metaId, {
        where: item.location ?? "",
        size: entry.size !== null ? formatSize(entry.size) : "",
        modified: entry.modified !== null ? formatShortDate(entry.modified) : "",
      });
    } else {
      row.setAttribute("aria-label", item.label);
      row.removeAttribute("aria-describedby");
      row.removeAttribute("aria-expanded");
      row.dataset.kind = item.type;
      if (item.type === "placeholder") row.setAttribute("aria-disabled", "true");
      else row.removeAttribute("aria-disabled");
      this.setRowContent(row, item.label, "", "", { where: "", size: "", modified: "" });
    }
  }

  /**
   * The spoken description lives in a visually hidden `.row-meta`; the
   * visible columns repeat it in short form and are hidden from assistive
   * tech so nothing is read twice.
   */
  private setRowContent(
    row: HTMLElement,
    name: string,
    meta: string,
    metaId: string,
    columns: { where: string; size: string; modified: string },
  ): void {
    let nameEl = row.querySelector<HTMLElement>(".row-name");
    let metaEl = row.querySelector<HTMLElement>(".row-meta");
    let whereEl = row.querySelector<HTMLElement>(".row-where");
    let sizeEl = row.querySelector<HTMLElement>(".row-size");
    let modifiedEl = row.querySelector<HTMLElement>(".row-modified");
    if (!nameEl || !metaEl || !whereEl || !sizeEl || !modifiedEl) {
      const span = (className: string) => {
        const el = document.createElement("span");
        el.className = className;
        return el;
      };
      nameEl = span("row-name");
      metaEl = span("row-meta");
      whereEl = span("row-where");
      sizeEl = span("row-size");
      modifiedEl = span("row-modified");
      const label = span("row-label");
      label.append(nameEl, whereEl);
      for (const el of [whereEl, sizeEl, modifiedEl]) el.setAttribute("aria-hidden", "true");
      row.replaceChildren(label, sizeEl, modifiedEl, metaEl);
    }
    if (nameEl.textContent !== name) nameEl.textContent = name;
    if (metaEl.textContent !== meta) metaEl.textContent = meta;
    if (whereEl.textContent !== columns.where) whereEl.textContent = columns.where;
    if (sizeEl.textContent !== columns.size) sizeEl.textContent = columns.size;
    if (modifiedEl.textContent !== columns.modified) modifiedEl.textContent = columns.modified;
    metaEl.id = metaId;
  }

  private indexFromEvent(e: Event): number | null {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
    if (!row?.dataset.index) return null;
    return Number(row.dataset.index);
  }

  private onClick(e: MouseEvent): void {
    const index = this.indexFromEvent(e);
    if (index !== null) this.focusIndex(index);
  }

  private pageSize(): number {
    return Math.max(1, Math.floor(this.root.clientHeight / this.measureRowHeight()) - 1);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const goUp =
      e.key === "Backspace" ||
      (e.key === "ArrowLeft" && !e.altKey && !e.metaKey && !e.ctrlKey) ||
      (e.key === "ArrowUp" && (e.altKey || e.metaKey));
    if (goUp) {
      e.preventDefault();
      this.handlers.onGoUp();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    const item = this.activeItem;
    switch (e.key) {
      case "ArrowDown":
        this.focusIndex(this.active + 1);
        break;
      case "ArrowUp":
        if (this.active === 0) this.handlers.onExitTop();
        else this.focusIndex(this.active - 1);
        break;
      case "Home":
        this.focusIndex(0);
        break;
      case "End":
        this.focusIndex(this.items.length - 1);
        break;
      case "PageDown":
        this.focusIndex(this.active + this.pageSize());
        break;
      case "PageUp":
        this.focusIndex(this.active - this.pageSize());
        break;
      case "Enter":
        if (item) this.handlers.onActivate(item, this.active);
        break;
      case "ArrowRight":
        if (item?.type === "entry" && item.entry.kind === "directory") {
          this.handlers.onActivate(item, this.active);
        }
        break;
      case "Escape":
        this.handlers.onEscape();
        break;
      default:
        // "/" is left to the app: it opens the location box (no name holds one)
        if (e.key.length === 1 && e.key !== " " && e.key !== "/") {
          this.typeAhead(e.key);
          break;
        }
        return;
    }
    e.preventDefault();
  }

  /** First-letter navigation; quickly typed letters form a prefix. */
  private typeAhead(char: string): void {
    window.clearTimeout(this.typeaheadTimer);
    this.typeaheadTimer = window.setTimeout(() => (this.typeahead = ""), TYPEAHEAD_RESET_MS);
    const repeated = this.typeahead.length === 1 && this.typeahead === char.toLowerCase();
    this.typeahead = repeated ? this.typeahead : this.typeahead + char.toLowerCase();

    const n = this.items.length;
    // A new or repeated single letter cycles; a longer prefix may stay put.
    const start = this.typeahead.length === 1 ? this.active + 1 : this.active;
    for (let step = 0; step < n; step++) {
      const i = (start + step) % n;
      const it = this.items[i];
      if (it.type === "entry" && it.entry.name.toLowerCase().startsWith(this.typeahead)) {
        this.focusIndex(i);
        return;
      }
    }
  }
}
