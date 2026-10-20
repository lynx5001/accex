/**
 * Search popup: a combobox (placed like every popup, see focus-manager)
 * with the results in a listbox below it. Nothing happens while typing; Enter searches, the
 * arrows move through the results (focus stays in the input,
 * `aria-activedescendant` follows), Enter on a result reveals it, Escape
 * dismisses and restores focus.
 */
import type { SearchHit, SearchResults } from "../../bridge/types";
import { closePopup, openPopup, registerPopup } from "../../accessibility/focus-manager";
import { formatCount, t } from "../../i18n";
import { describeEntry } from "../tree/file-tree";

/** Hits fetched per page; "Show more results" asks for one more page. */
export const SEARCH_PAGE = 200;

export interface SearchContext {
  /** Name of the folder being searched. */
  scopeName: string;
  restoreFallback: () => void;
  /** Runs the search; resolves null when it failed (already announced). */
  search(query: string, limit: number): Promise<SearchResults | null>;
  /** True when the input is a path to go to rather than a query. */
  isLocation(input: string): boolean;
  onLocation(input: string): void;
  /** A result was chosen; the popup is already closed. */
  onPick(hit: SearchHit): void;
}

export class SearchPopup {
  private ctx: SearchContext | null = null;
  private query = "";
  private limit = SEARCH_PAGE;
  private results: SearchResults | null = null;
  /** Index into the hits; `hits.length` is the "more" option, -1 is none. */
  private active = -1;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly input: HTMLInputElement,
    private readonly list: HTMLUListElement,
  ) {
    registerPopup(dialog);
    input.placeholder = t("search.placeholder");
    list.setAttribute("aria-label", t("search.resultsLabel"));
    input.addEventListener("keydown", (e) => this.onKeyDown(e));
    list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
      if (!li?.dataset.index) return;
      this.active = Number(li.dataset.index);
      this.choose();
    });
  }

  /**
   * Opens the popup. The previous query is kept and
   * selected, so the user can refine or overwrite it.
   */
  open(ctx: SearchContext): void {
    this.ctx = ctx;
    this.clearResults();
    this.input.setAttribute("aria-label", t("search.inputLabel", { name: ctx.scopeName }));
    openPopup(this.dialog, { initialFocus: this.input, restoreFallback: ctx.restoreFallback });
    this.input.select();
  }

  private async submit(limit: number): Promise<void> {
    const ctx = this.ctx;
    const query = this.input.value.trim();
    if (!ctx || !query) return;
    if (ctx.isLocation(query)) {
      closePopup(this.dialog, false);
      ctx.onLocation(query);
      return;
    }
    const previous = this.query === query ? (this.results?.hits.length ?? 0) : 0;
    this.list.setAttribute("aria-busy", "true");
    const results = await ctx.search(query, limit);
    this.list.setAttribute("aria-busy", "false");
    if (!results || !this.dialog.open) return;
    this.query = query;
    this.limit = limit;
    this.results = results;
    // After "show more", continue at the first new hit.
    this.active = previous && previous < results.hits.length ? previous : -1;
    this.render();
  }

  private choose(): void {
    const results = this.results;
    if (!results || this.active < 0) return;
    if (this.active === results.hits.length) {
      void this.submit(this.limit + SEARCH_PAGE);
      return;
    }
    const hit = results.hits[this.active];
    if (!hit) return;
    closePopup(this.dialog, false);
    this.ctx?.onPick(hit);
  }

  private clearResults(): void {
    this.results = null;
    this.active = -1;
    this.list.hidden = true;
    this.list.replaceChildren();
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }

  private render(): void {
    const results = this.results;
    if (!results) return;
    const items = results.hits.map((hit, i) => {
      const li = this.option(i, hit.name);
      li.dataset.kind = hit.kind === "directory" ? "directory" : "file";
      li.setAttribute("aria-label", `${hit.name}, ${describeEntry(hit, hit.parent)}`);
      const where = document.createElement("span");
      where.className = "row-meta";
      where.textContent = hit.parent;
      li.append(where);
      return li;
    });
    if (results.truncated) {
      const shown = formatCount(results.hits.length);
      const label =
        results.total > results.hits.length
          ? t("tree.moreResults", { shown, total: formatCount(results.total) })
          : t("tree.moreResultsUnknown", { shown });
      const more = this.option(results.hits.length, label);
      more.classList.add("more");
      items.push(more);
    }
    if (!items.length) {
      const li = document.createElement("li");
      li.id = "search-result-none";
      li.setAttribute("role", "option");
      li.setAttribute("aria-disabled", "true");
      li.textContent = t("tree.noResults");
      items.push(li);
    }
    this.list.replaceChildren(...items);
    this.list.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.sync();
  }

  private option(index: number, name: string): HTMLLIElement {
    const li = document.createElement("li");
    li.id = `search-result-${index}`;
    li.setAttribute("role", "option");
    li.dataset.index = String(index);
    const label = document.createElement("span");
    label.className = "row-name";
    label.textContent = name;
    li.append(label);
    return li;
  }

  private sync(): void {
    this.list.querySelectorAll<HTMLElement>("[role=option]").forEach((li) => {
      li.setAttribute("aria-selected", String(li.dataset.index === String(this.active)));
    });
    const current = document.getElementById(`search-result-${this.active}`);
    if (this.active >= 0 && current) {
      this.input.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else {
      this.input.removeAttribute("aria-activedescendant");
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const count = this.results ? this.results.hits.length + (this.results.truncated ? 1 : 0) : 0;
    switch (e.key) {
      case "ArrowDown":
        if (!count) return;
        this.active = (this.active + 1) % count;
        this.sync();
        break;
      case "ArrowUp":
        if (!count) return;
        this.active = this.active <= 0 ? count - 1 : this.active - 1;
        this.sync();
        break;
      case "Enter":
        // A highlighted result for the current text opens; otherwise search.
        if (this.active >= 0 && this.input.value.trim() === this.query) this.choose();
        else void this.submit(SEARCH_PAGE);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
