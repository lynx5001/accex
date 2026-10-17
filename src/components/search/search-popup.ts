/**
 * Search popup: focus jumps into a `role="searchbox"` input. Nothing happens
 * while typing; Enter submits, Escape dismisses and restores focus.
 */
import { closePopup, openPopup, registerPopup } from "../../accessibility/focus-manager";
import { t } from "../../i18n";

export class SearchPopup {
  private onSubmit: ((query: string) => void) | null = null;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly input: HTMLInputElement,
  ) {
    registerPopup(dialog);
    input.placeholder = t("search.placeholder");
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const query = input.value.trim();
      if (!query) return;
      closePopup(dialog, false);
      this.onSubmit?.(query);
    });
  }

  /**
   * Opens the popup for the folder `scopeName`. The previous query is kept
   * and selected, so the user can refine or overwrite it.
   */
  open(scopeName: string, restoreFallback: () => void, onSubmit: (query: string) => void): void {
    this.onSubmit = onSubmit;
    this.input.setAttribute("aria-label", t("search.inputLabel", { name: scopeName }));
    openPopup(this.dialog, { initialFocus: this.input, restoreFallback });
    this.input.select();
  }
}
