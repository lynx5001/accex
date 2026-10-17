/**
 * The application controller: owns the browse/search state and wires
 * keyboard shortcuts, components and the Rust bridge together.
 */
import { announce, announceError, initAnnouncer } from "./accessibility/announcer";
import { closeAllPopups, isPopupOpen } from "./accessibility/focus-manager";
import * as api from "./bridge/commands";
import {
  isAppError,
  type DirectoryListing,
  type FileEntry,
  type Operation,
  type OperationOutcome,
  type OperationType,
  type SearchResults,
} from "./bridge/types";
import { BookmarksPopup } from "./components/bookmarks/bookmarks-popup";
import { Breadcrumbs } from "./components/breadcrumbs/breadcrumbs";
import { CommandPalette } from "./components/palette/command-palette";
import { SearchPopup } from "./components/search/search-popup";
import { FileTree, type TreeItem } from "./components/tree/file-tree";
import { formatCount, locale, t, type MessageKey } from "./i18n";

const SEARCH_PAGE = 200;
const REFRESH_DEBOUNCE_MS = 200;

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
  private search: { query: string; limit: number; results: SearchResults } | null = null;
  /** Folder path → path of the item that was focused there. */
  private readonly focusMemory = new Map<string, string>();
  private refreshTimer: number | undefined;
  private readonly keyListener = (e: KeyboardEvent) => this.onGlobalKey(e);
  private readonly unlisten: Promise<() => void>;

  private readonly tree: FileTree;
  private readonly breadcrumbs: Breadcrumbs;
  private readonly searchPopup: SearchPopup;
  private readonly palette: CommandPalette;
  private readonly bookmarks: BookmarksPopup;

  constructor() {
    this.tree = new FileTree($("file-list"), {
      onActivate: (item) => void this.activate(item),
      onGoUp: () => void this.goUp(),
      onEscape: () => this.exitSearch(),
      onExitTop: () => this.focusBreadcrumb(),
    });
    this.breadcrumbs = new Breadcrumbs($("breadcrumbs"), {
      onNavigate: (path) => void this.navigate(path, { focusPath: this.childTowardsCurrent(path) }),
      onFocusContent: () => this.tree.focusActive(),
    });
    this.searchPopup = new SearchPopup($("search-dialog"), $("search-input"));
    this.palette = new CommandPalette($("palette-dialog"), $("palette-input"), $("palette-list"));
    this.bookmarks = new BookmarksPopup($("bookmarks-dialog"), $("bookmarks-list"));

    document.addEventListener("keydown", this.keyListener);
    this.unlisten = api.onFsChange((change) => {
      if (!this.search && change.directory === this.listing?.path) this.scheduleRefresh();
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
    await this.navigate(await api.initialLocation());
  }

  // ---------------------------------------------------------------- browse

  private rememberFocus(): void {
    const item = this.tree.activeItem;
    if (this.listing && !this.search && item?.type === "entry") {
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
    this.search = null;
    document.title = `${listing.name} – ${t("app.title")}`;
    this.breadcrumbs.render(listing.breadcrumbs);
    this.tree.setItems(this.entryItems(listing), {
      label: t("tree.label", { name: listing.name }),
      focusPath: focusPath ?? this.focusMemory.get(listing.path),
      focus,
    });
  }

  async navigate(
    path: string,
    options: { focusPath?: string; quiet?: boolean } = {},
  ): Promise<void> {
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
    } catch (err) {
      this.tree.setBusy(false);
      if (isAppError(err) && err.kind === "notFound" && this.listing?.path !== path) {
        await this.fallbackFrom(path);
      } else {
        announceError(errorMessage(err));
        if (!this.listing) await this.fallbackFrom(path);
      }
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
    if (this.search) {
      this.exitSearch();
      return;
    }
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
    if (!current || this.search) return;
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
    if (item.type === "more") {
      if (this.search) await this.runSearch(this.search.query, this.search.limit + SEARCH_PAGE);
      return;
    }
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
    this.searchPopup.open(
      scope.name,
      () => this.tree.focusActive(),
      (query) => void this.submitSearch(query),
    );
  }

  private async submitSearch(query: string): Promise<void> {
    if (looksLikePath(query)) {
      try {
        const location = await api.resolveLocation(query);
        if (location.isDirectory) await this.navigate(location.path);
        else {
          const parent = location.path.slice(
            0,
            location.path.length - baseName(location.path).length,
          );
          await this.navigate(parent, { focusPath: location.path });
        }
      } catch (err) {
        announceError(errorMessage(err));
        this.tree.focusActive();
      }
      return;
    }
    await this.runSearch(query, SEARCH_PAGE);
  }

  private async runSearch(query: string, limit: number): Promise<void> {
    const scope = this.listing;
    if (!scope) return;
    if (!this.search) this.rememberFocus();
    const previousCount = this.search?.query === query ? this.search.results.hits.length : 0;
    announce(t("search.searching"));
    this.tree.setBusy(true);
    try {
      const results = await api.searchFiles(scope.path, query, limit);
      this.search = { query, limit, results };
      const items: TreeItem[] = results.hits.map((hit) => ({
        type: "entry",
        entry: hit,
        location: hit.parent,
      }));
      if (!items.length) items.push({ type: "placeholder", label: t("tree.noResults") });
      if (results.truncated) {
        items.push({
          type: "more",
          label:
            results.total > results.hits.length
              ? t("tree.moreResults", {
                  shown: formatCount(results.hits.length),
                  total: formatCount(results.total),
                })
              : t("tree.moreResultsUnknown", { shown: formatCount(results.hits.length) }),
        });
      }
      this.tree.setItems(items, {
        label: t("tree.searchLabel", { query }),
        focusIndex: previousCount,
        focus: true,
      });
      announce(this.resultsMessage(query, results));
    } catch (err) {
      this.tree.setBusy(false);
      announceError(errorMessage(err));
      this.tree.focusActive();
    }
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

  /** Escape on results: restore the folder contents and previous focus. */
  private exitSearch(): void {
    if (!this.search || !this.listing) return;
    this.search = null;
    void this.navigate(this.listing.path, { quiet: true }).then(() => announce(t("search.closed")));
  }

  // ------------------------------------------------------------ operations

  private openPalette(): void {
    const item = this.tree.activeItem;
    const target = item?.type === "entry" ? item.entry : null;
    const available: OperationType[] = target
      ? ["open", "copy", "cut", "paste", "delete", "rename", "bookmark"]
      : ["paste", "bookmark"];
    this.palette.open({
      targetName: target?.name ?? null,
      available,
      restoreFallback: () => this.tree.focusActive(),
      onRun: (op, newName) => void this.runOperation(op, target, newName),
    });
  }

  private async runOperation(
    op: OperationType,
    target: FileEntry | null,
    newName?: string,
  ): Promise<void> {
    const current = this.listing;
    if (!current) return;
    // Paste and bookmark act on the current folder; the rest on the item.
    const path = op === "paste" || op === "bookmark" || !target ? current.path : target.path;
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
        await this.reloadView(outcome.path, index);
        announce(
          t(outcome.mode === "copy" ? "outcome.pasted" : "outcome.moved", { name: outcome.name }),
        );
        return;
      case "renamed":
        await this.reloadView(outcome.path, index);
        announce(t("outcome.renamed", { name: outcome.name }));
        return;
      case "deleted":
        await this.reloadView(undefined, index);
        announce(t("outcome.deleted", { name: outcome.name }));
        return;
    }
  }

  private async reloadView(focusPath: string | undefined, focusIndex: number): Promise<void> {
    if (this.search) {
      await this.runSearch(this.search.query, this.search.limit);
      this.tree.focusIndex(focusIndex);
    } else {
      await this.refresh(focusPath, focusIndex);
    }
  }

  // ------------------------------------------------------------- bookmarks

  private async openBookmarks(): Promise<void> {
    const list = await api.listBookmarks();
    this.bookmarks.open(list, {
      restoreFallback: () => this.tree.focusActive(),
      onGo: (b) => void this.navigate(b.path),
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

  // -------------------------------------------------------------- keyboard

  private focusBreadcrumb(): void {
    $("breadcrumbs").querySelector<HTMLButtonElement>("button[tabindex='0']")?.focus();
  }

  private announceLocation(): void {
    if (!this.listing) return;
    announce(t("location.announce", { path: Breadcrumbs.spoken(this.listing.breadcrumbs) }));
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (isPopupOpen()) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && !e.altKey && key === "f") this.openSearch();
    else if (mod && !e.altKey && key === "b") void this.openBookmarks();
    else if (mod && !e.altKey && key === "l") this.announceLocation();
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) this.openPalette();
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
}

/** Localizes the static markup, connects live regions and creates the app. */
export function bootstrap(): App {
  localizeDocument();
  initAnnouncer($("status-announcer"), $("error-announcer"));
  return new App();
}
