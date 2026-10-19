/**
 * Location breadcrumb: a single Tab stop (roving tabindex). Left/Right move
 * between segments, Enter/Space navigates. The last segment carries
 * `aria-current="location"`.
 *
 * Clicking the field outside a segment swaps it for a text box to type a
 * path into; Enter goes there, Escape or leaving the box restores it.
 */
import type { PathSegment } from "../../bridge/types";
import { t } from "../../i18n";

export interface BreadcrumbHandlers {
  onNavigate(path: string): void;
  /** Down arrow / activating the current segment returns to the list. */
  onFocusContent(): void;
  /** A typed location; resolves false when it could not be opened. */
  onSubmitLocation(input: string): Promise<boolean>;
}

export class Breadcrumbs {
  private segments: PathSegment[] = [];
  private homePath: string | null = null;
  private submitting = false;

  constructor(
    private readonly list: HTMLOListElement,
    private readonly input: HTMLInputElement,
    private readonly handlers: BreadcrumbHandlers,
  ) {
    list.addEventListener("keydown", (e) => this.onKeyDown(e));
    list.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("button")) this.edit();
    });
    input.addEventListener("keydown", (e) => this.onInputKeyDown(e));
    input.addEventListener("blur", () => {
      if (!this.submitting) this.closeEditor();
    });
  }

  get editing(): boolean {
    return !this.input.hidden;
  }

  /** Shows the text box, prefilled with `text` or else the current path. */
  edit(text?: string): void {
    const current = this.segments[this.segments.length - 1]?.path ?? "";
    this.input.value = text ?? current;
    this.list.hidden = true;
    this.input.hidden = false;
    this.input.focus();
    if (text === undefined) this.input.select();
    else this.input.setSelectionRange(text.length, text.length);
  }

  private closeEditor(): void {
    this.input.hidden = true;
    this.list.hidden = false;
  }

  private async submit(): Promise<void> {
    const value = this.input.value.trim();
    if (!value) return;
    this.submitting = true;
    try {
      if (await this.handlers.onSubmitLocation(value)) this.closeEditor();
      else this.input.select();
    } finally {
      this.submitting = false;
    }
  }

  private onInputKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter") void this.submit();
    else if (e.key === "Escape") {
      this.closeEditor();
      this.handlers.onFocusContent();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Display name of a segment (`/` is spoken as "Root"). */
  static label(segment: PathSegment): string {
    return segment.name === "/" || segment.name === "\\" ? t("location.root") : segment.name;
  }

  /** Spoken form of the whole path, e.g. "Root / home / Documents". */
  static spoken(segments: PathSegment[]): string {
    return segments.map(Breadcrumbs.label).join(t("location.separator"));
  }

  /** Inside this folder the path starts at a single "Home" segment. */
  set home(path: string | null) {
    this.homePath = path;
  }

  render(segments: PathSegment[]): void {
    const homeIndex = segments.findIndex((s) => s.path === this.homePath);
    if (homeIndex > 0) segments = segments.slice(homeIndex);
    this.segments = segments;
    const items = segments.map((segment, i) => {
      const li = document.createElement("li");
      // The root's own "/" already separates it from the next segment.
      if (segment.name === "/") li.className = "root";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "breadcrumb";
      if (homeIndex > 0 && i === 0) {
        button.classList.add("home");
        button.textContent = t("location.home");
      } else {
        button.textContent = segment.name;
        button.setAttribute("aria-label", Breadcrumbs.label(segment));
      }
      button.dataset.index = String(i);
      button.tabIndex = i === segments.length - 1 ? 0 : -1;
      if (i === segments.length - 1) button.setAttribute("aria-current", "location");
      button.addEventListener("click", () => this.activate(i));
      li.append(button);
      return li;
    });
    this.list.replaceChildren(...items);
  }

  private buttons(): HTMLButtonElement[] {
    return Array.from(this.list.querySelectorAll<HTMLButtonElement>("button"));
  }

  private activate(index: number): void {
    if (index === this.segments.length - 1) this.handlers.onFocusContent();
    else this.handlers.onNavigate(this.segments[index].path);
  }

  private move(to: number): void {
    const buttons = this.buttons();
    if (!buttons.length) return;
    const target = Math.max(0, Math.min(buttons.length - 1, to));
    buttons.forEach((b, i) => (b.tabIndex = i === target ? 0 : -1));
    buttons[target].focus();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const current = Number((e.target as HTMLElement).dataset.index ?? -1);
    if (current < 0) return;
    switch (e.key) {
      case "ArrowLeft":
        this.move(current - 1);
        break;
      case "ArrowRight":
        this.move(current + 1);
        break;
      case "Home":
        this.move(0);
        break;
      case "End":
        this.move(this.segments.length - 1);
        break;
      case "ArrowDown":
        this.handlers.onFocusContent();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
