/**
 * The application controller: owns the browse state and wires keyboard
 * shortcuts, components and the Rust bridge together.
 */
import { announce, announceError, initAnnouncer } from "./accessibility/announcer";
import {
  closeAllPopups,
  closePopup,
  isPopupOpen,
  setPopupAnchor,
  topPopup,
  type PopupPoint,
} from "./accessibility/focus-manager";
import * as api from "./bridge/commands";
import {
  isAppError,
  type DirectoryListing,
  type FileEntry,
  type Operation,
  type OperationOutcome,
  type OperationType,
  type SearchHit,
  type SearchResults,
} from "./bridge/types";
import { BookmarksPopup } from "./components/bookmarks/bookmarks-popup";
import { Breadcrumbs } from "./components/breadcrumbs/breadcrumbs";
import { ContextMenu } from "./components/context-menu/context-menu";
import { CommandPalette } from "./components/palette/command-palette";
import { SearchPopup } from "./components/search/search-popup";
import { FileTree, type TreeItem } from "./components/tree/file-tree";
import { formatCount, locale, t, type MessageKey } from "./i18n";

const REFRESH_DEBOUNCE_MS = 200;
/** WebKit follows the Menu key / Shift+F10 with a `contextmenu` event; ignore it this long. */
const MENU_KEY_ECHO_MS = 500;

/** Operations on a file or folder, offered by the context menu and the palette. */
const ITEM_OPS: OperationType[] = ["open", "copy", "cut", "paste", "delete", "rename", "bookmark"];

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Heuristic: input that should be treated as a location, not a query. */
function looksLikePath(input: string): boolean {
  return /^(~([\\/]|$)|\/|[a-zA-Z]:[\\/]|\\\\)/.test(input);
}

/** Translated, screen-reader-friendly text for any error. */
export function errorMessage(err: unknown): string {
  if (isAppError(err)) {
    const name = err.path ? baseName(err.path) : "";
    return t(`error.${err.kind}` as MessageKey, { name, message: err.message });
  }
  return t("error.unknown");
}

function signature(entries: FileEntry[]): string {
  return entries.map((e) => `${e.path}|${e.modified}|${e.size}`).join("\n");
}

export class App {
  private listing: DirectoryListing | null = null;
  /** Folder path → path of the item that was focused there. */
  private readonly focusMemory = new Map<string, string>();
  private refreshTimer: number | undefined;
  /** When the Menu key / Shift+F10 was last pressed (see MENU_KEY_ECHO_MS). */
  private menuKeyAt = -Infinity;
  private readonly keyListener = (e: KeyboardEvent) => this.onGlobalKey(e);
  private readonly unlisten: Promise<() => void>;

  private readonly tree: FileTree;
  private readonly breadcrumbs: Breadcrumbs;
  private readonly searchPopup: SearchPopup;
  private readonly palette: CommandPalette;
  private readonly contextMenu: ContextMenu;
  private readonly bookmarks: BookmarksPopup;

  constructor() {
    this.tree = new FileTree($("file-list"), {
      onActivate: (item) => void this.activate(item),
      onGoUp: () => void this.goUp(),
      onExitTop: () => this.focusBreadcrumb(),
    });
    this.breadcrumbs = new Breadcrumbs($("breadcrumbs"), $("location-input"), {
      onNavigate: (path) => void this.navigate(path, { focusPath: this.childTowardsCurrent(path) }),
      onFocusContent: () => this.tree.focusActive(),
      onSubmitLocation: (input) => this.goToLocation(input),
    });
    this.searchPopup = new SearchPopup($("search-dialog"), $("search-input"), $("search-results"));
    this.palette = new CommandPalette($("palette-dialog"), $("palette-input"), $("palette-list"));
    this.bookmarks = new BookmarksPopup($("bookmarks-dialog"), $("bookmarks-list"));
    this.contextMenu = new ContextMenu($("context-dialog"), $("context-menu"));
    $("file-list").addEventListener("contextmenu", (e) => this.onRightClick(e));

    setPopupAnchor($("location"));
    $("search-button").addEventListener("click", () => this.openSearch());
    document.addEventListener("keydown", this.keyListener);
    this.unlisten = api.onFsChange((change) => {
      if (change.directory === this.listing?.path) this.scheduleRefresh();
    });
  }

  /** Detaches global listeners (used by tests and hot reload). */
  dispose(): void {
    document.removeEventListener("keydown", this.keyListener);
    window.clearTimeout(this.refreshTimer);
    closeAllPopups();
    this.unlisten.then((stop) => stop()).catch(() => {});
  }

  async start(): Promise<void> {
    this.breadcrumbs.home = await api
      .resolveLocation("~")
      .then((home) => home.path)
      .catch(() => null);
    await this.navigate(await api.initialLocation());
  }

  // ---------------------------------------------------------------- browse

  private rememberFocus(): void {
    const item = this.tree.activeItem;
    if (this.listing && item?.type === "entry") {
      this.focusMemory.set(this.listing.path, item.entry.path);
    }
  }

  /** When jumping to an ancestor, focus the child on the way back down. */
  private childTowardsCurrent(ancestor: string): string | undefined {
    const segments = this.listing?.breadcrumbs ?? [];
    const i = segments.findIndex((s) => s.path === ancestor);
    return i >= 0 ? segments[i + 1]?.path : undefined;
  }

  private entryItems(listing: DirectoryListing): TreeItem[] {
    if (!listing.entries.length) return [{ type: "placeholder", label: t("tree.empty") }];
    return listing.entries.map((entry) => ({ type: "entry", entry }));
  }

  private showListing(listing: DirectoryListing, focusPath?: string, focus = true): void {
    this.listing = listing;
    document.title = `${listing.name} – ${t("app.title")}`;
    this.breadcrumbs.render(listing.breadcrumbs);
    this.tree.setItems(this.entryItems(listing), {
      label: t("tree.label", { name: listing.name }),
      focusPath: focusPath ?? this.focusMemory.get(listing.path),
      focus,
    });
  }

  /** Resolves true when `path` itself was opened. */
  async navigate(
    path: string,
    options: { focusPath?: string; quiet?: boolean } = {},
  ): Promise<boolean> {
    this.rememberFocus();
    this.tree.setBusy(true);
    try {
      const listing = await api.readDirectory(path);
      this.showListing(listing, options.focusPath);
      if (!options.quiet) {
        const count = listing.entries.length;
        announce(
          count
            ? t("nav.opened", { name: listing.name, count: formatCount(count) })
            : t("nav.openedEmpty", { name: listing.name }),
        );
      }
      return true;
    } catch (err) {
      this.tree.setBusy(false);
      if (isAppError(err) && err.kind === "notFound" && this.listing?.path !== path) {
        await this.fallbackFrom(path);
      } else {
        announceError(errorMessage(err));
        if (!this.listing) await this.fallbackFrom(path);
      }
      return false;
    }
  }

  /**
   * Opens a typed location: a folder, or a file's folder with the file
   * focused. Relative input is taken from the current folder.
   */
  private async goToLocation(input: string): Promise<boolean> {
    const current = this.listing?.path;
    const absolute = looksLikePath(input) || !current ? input : `${current}/${input}`;
    try {
      const location = await api.resolveLocation(absolute);
      if (location.isDirectory) return await this.navigate(location.path);
      const parent = location.path.slice(0, location.path.length - baseName(location.path).length);
      return await this.navigate(parent, { focusPath: location.path });
    } catch (err) {
      announceError(errorMessage(err));
      return false;
    }
  }

  /** The folder vanished (disk unplugged, deleted): go to the nearest parent. */
  private async fallbackFrom(path: string): Promise<void> {
    const target = await api.fallbackDirectory(path);
    try {
      const listing = await api.readDirectory(target);
      this.showListing(listing);
      announce(t("nav.fallback", { name: listing.name }));
    } catch (err) {
      announceError(errorMessage(err));
    }
  }

  private async goUp(): Promise<void> {
    const listing = this.listing;
    if (!listing?.parent) {
      announce(t("nav.atRoot"));
      return;
    }
    await this.navigate(listing.parent, { focusPath: listing.path });
  }

  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  /** Re-reads the current folder, keeping focus on the same item if possible. */
  private async refresh(focusPath?: string, focusIndex?: number): Promise<void> {
    const current = this.listing;
    if (!current) return;
    try {
      const listing = await api.readDirectory(current.path);
      if (focusPath === undefined && focusIndex === undefined) {
        if (signature(listing.entries) === signature(current.entries)) return;
      }
      const active = this.tree.activeItem;
      this.listing = listing;
      this.tree.setItems(this.entryItems(listing), {
        label: t("tree.label", { name: listing.name }),
        focusPath: focusPath ?? (active?.type === "entry" ? active.entry.path : undefined),
        focusIndex: focusIndex ?? this.tree.activeIndex,
        focus: focusPath !== undefined || focusIndex !== undefined,
      });
    } catch (err) {
      if (isAppError(err) && err.kind === "notFound") await this.fallbackFrom(current.path);
      else announceError(errorMessage(err));
    }
  }

  private async activate(item: TreeItem): Promise<void> {
    if (item.type !== "entry") return;
    if (item.entry.kind === "directory") {
      await this.navigate(item.entry.path);
    } else {
      await this.runOperation("open", item.entry);
    }
  }

  // ---------------------------------------------------------------- search

  private openSearch(): void {
    const scope = this.listing;
    if (!scope) return;
    const backToList = (ok: boolean) => {
      if (!ok) this.tree.focusActive();
    };
    this.searchPopup.open({
      scopeName: scope.name,
      restoreFallback: () => this.tree.focusActive(),
      search: (query, limit) => this.search(scope.path, query, limit),
      isLocation: looksLikePath,
      onLocation: (input) => void this.goToLocation(input).then(backToList),
      onPick: (hit) => void this.reveal(hit).then(backToList),
    });
  }

  private async search(scope: string, query: string, limit: number): Promise<SearchResults | null> {
    announce(t("search.searching"));
    try {
      const results = await api.searchFiles(scope, query, limit);
      announce(this.resultsMessage(query, results));
      return results;
    } catch (err) {
      announceError(errorMessage(err));
      return null;
    }
  }

  /** Opens a found folder, or a found file's folder with the file focused. */
  private reveal(hit: SearchHit): Promise<boolean> {
    return hit.kind === "directory"
      ? this.navigate(hit.path)
      : this.navigate(hit.parent, { focusPath: hit.path });
  }

  private resultsMessage(query: string, r: SearchResults): string {
    const shown = r.hits.length;
    if (!shown) return t("search.noResults", { query });
    if (r.truncated && r.total > shown) {
      return t("search.resultsTruncated", {
        shown: formatCount(shown),
        total: formatCount(r.total),
      });
    }
    return shown === 1
      ? t("search.resultsOne")
      : t("search.results", { count: formatCount(shown) });
  }

  // ------------------------------------------------------------ operations

  private openPalette(): void {
    const item = this.tree.activeItem;
    const target = item?.type === "entry" ? item.entry : null;
    this.palette.open({
      targetName: target?.name ?? null,
      available: target ? ITEM_OPS : ["paste", "bookmark"],
      restoreFallback: () => this.tree.focusActive(),
      onRun: (op, newName) => void this.runOperation(op, target, newName),
    });
  }

  /**
   * Opens the context menu at `at` for the active row, or for the current
   * folder when `onItem` is false (a right click on empty space).
   */
  private openContextMenu(at: PopupPoint, onItem = true): void {
    const item = this.tree.activeItem;
    const target = onItem && item?.type === "entry" ? item.entry : null;
    this.contextMenu.open({
      at,
      targetName: target?.name ?? null,
      available: target ? ["open", "cut", "copy", "paste", "rename", "delete"] : ["paste"],
      restoreFallback: () => this.tree.focusActive(),
      onRun: (op) => {
        // Rename needs a new name: the palette's prompt asks for it.
        if (op === "rename" && target) {
          this.palette.openRename({
            targetName: target.name,
            available: ITEM_OPS,
            restoreFallback: () => this.tree.focusActive(),
            onRun: (renameOp, newName) => void this.runOperation(renameOp, target, newName),
          });
        } else {
          void this.runOperation(op, target);
        }
      },
    });
  }

  /** Menu key / Shift+F10: open the menu just below the active row's name. */
  private openContextMenuAtRow(): void {
    const rect = this.tree.activeRowRect() ?? $("file-list").getBoundingClientRect();
    this.openContextMenu({ x: rect.left + 48, y: rect.bottom, above: rect.top });
  }

  private onRightClick(e: MouseEvent): void {
    e.preventDefault();
    if (isPopupOpen() || performance.now() - this.menuKeyAt < MENU_KEY_ECHO_MS) return;
    const index = this.tree.indexAt(e);
    if (index !== null) this.tree.focusIndex(index);
    this.openContextMenu({ x: e.clientX, y: e.clientY }, index !== null);
  }

  private async runOperation(
    op: OperationType,
    target: FileEntry | null,
    newName?: string,
  ): Promise<void> {
    const current = this.listing;
    if (!current) return;
    // Paste acts on the current folder; the rest on the item (bookmark falls
    // back to the current folder when no item is focused).
    const path = op === "paste" || !target ? current.path : target.path;
    const operation: Operation =
      op === "rename" ? { type: op, newName: newName ?? "" } : { type: op };
    try {
      const outcome = await api.executeOperation(operation, path);
      await this.afterOperation(outcome);
    } catch (err) {
      announceError(errorMessage(err));
    }
  }

  private async afterOperation(outcome: OperationOutcome): Promise<void> {
    const index = this.tree.activeIndex;
    switch (outcome.type) {
      case "navigate":
        await this.navigate(outcome.path);
        return;
      case "opened":
        announce(t("outcome.opened", { name: outcome.name }));
        return;
      case "clipboard":
        announce(
          t(outcome.mode === "copy" ? "outcome.copied" : "outcome.cut", { name: outcome.name }),
        );
        return;
      case "bookmarked":
        announce(
          t(outcome.added ? "outcome.bookmarked" : "outcome.alreadyBookmarked", {
            name: outcome.name,
          }),
        );
        return;
      case "pasted":
        await this.refresh(outcome.path, index);
        announce(
          t(outcome.mode === "copy" ? "outcome.pasted" : "outcome.moved", { name: outcome.name }),
        );
        return;
      case "renamed":
        await this.refresh(outcome.path, index);
        announce(t("outcome.renamed", { name: outcome.name }));
        return;
      case "deleted":
        await this.refresh(undefined, index);
        announce(t("outcome.deleted", { name: outcome.name }));
        return;
    }
  }

  // ------------------------------------------------------------- bookmarks

  private async openBookmarks(): Promise<void> {
    const list = await api.listBookmarks();
    this.bookmarks.open(list, {
      restoreFallback: () => this.tree.focusActive(),
      // Folders open; files open their folder with the file focused.
      onGo: (b) =>
        void this.goToLocation(b.path).then((ok) => {
          if (!ok) this.tree.focusActive();
        }),
      onRemove: async (b) => {
        try {
          await api.removeBookmark(b.path);
          announce(t("bookmarks.removed", { name: b.name }));
        } catch (err) {
          announceError(errorMessage(err));
          throw err;
        }
      },
    });
  }

  /**
   * Bookmarks the focused file or folder (the current folder if none), or
   * removes the bookmark when it already exists.
   */
  private async toggleBookmark(): Promise<void> {
    const item = this.tree.activeItem;
    const path = item?.type === "entry" ? item.entry.path : this.listing?.path;
    if (!path) return;
    try {
      const outcome = await api.executeOperation({ type: "bookmark" }, path);
      if (outcome.type !== "bookmarked") return;
      if (outcome.added) {
        announce(t("outcome.bookmarked", { name: outcome.name }));
      } else {
        await api.removeBookmark(path);
        announce(t("bookmarks.removed", { name: outcome.name }));
      }
    } catch (err) {
      announceError(errorMessage(err));
    }
  }

  // -------------------------------------------------------------- keyboard

  private focusBreadcrumb(): void {
    $("breadcrumbs").querySelector<HTMLButtonElement>("button[tabindex='0']")?.focus();
  }

  private announceLocation(): void {
    if (!this.listing) return;
    announce(t("location.announce", { path: Breadcrumbs.spoken(this.listing.breadcrumbs) }));
  }

  private onGlobalKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const menuKey = e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
    if (menuKey) this.menuKeyAt = performance.now();
    const popupKey =
      mod && !e.altKey && key === "f"
        ? "search-dialog"
        : mod && !e.altKey && key === "b"
          ? "bookmarks-dialog"
          : mod && !e.altKey && key === "k"
            ? "palette-dialog"
            : menuKey
              ? "context-dialog"
              : null;

    // While a popup is open, only its own shortcut works: it closes it again.
    if (isPopupOpen()) {
      const top = topPopup();
      if (top && popupKey === top.id) {
        e.preventDefault();
        closePopup(top);
      }
      return;
    }

    if (popupKey === "search-dialog") this.openSearch();
    else if (popupKey === "bookmarks-dialog") void this.openBookmarks();
    else if (popupKey === "palette-dialog") this.openPalette();
    else if (popupKey === "context-dialog") this.openContextMenuAtRow();
    else if (mod && !e.altKey && key === "d") void this.toggleBookmark();
    else if (mod && !e.altKey && key === "l") this.announceLocation();
    else if (e.key === "/" && !mod && !e.altKey && !(e.target instanceof HTMLInputElement))
      this.breadcrumbs.edit("/");
    else if ((e.altKey || e.metaKey) && e.key === "ArrowUp" && !this.tree.hasFocus())
      void this.goUp();
    else if (e.target === document.body && e.key.startsWith("Arrow")) this.tree.focusActive();
    else return;
    e.preventDefault();
  }
}

/** Fills static strings marked with `data-i18n` in index.html. */
function localizeDocument(): void {
  document.documentElement.lang = locale;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n as MessageKey);
  });
  $("file-list").setAttribute("aria-label", t("tree.loading"));
  $("location-input").setAttribute("aria-label", t("location.edit"));
  $("search-button").setAttribute("aria-label", t("location.search"));
  $("context-dialog").setAttribute("aria-label", t("menu.dialogLabel"));
}

/** Localizes the static markup, connects live regions and creates the app. */
export function bootstrap(): App {
  localizeDocument();
  initAnnouncer($("status-announcer"), $("error-announcer"));
  return new App();
}
