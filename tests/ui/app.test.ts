/**
 * UI integration tests: the real index.html and App, with the Rust bridge
 * replaced by an in-memory fake file system via Tauri's IPC mocks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import axe from "axe-core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrap, type App } from "../../src/app";
import type { DirectoryListing, FileEntry } from "../../src/bridge/types";

const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");

function entry(path: string, kind: FileEntry["kind"] = "file"): FileEntry {
  const name = path.split("/").pop()!;
  const ext = kind === "file" && name.includes(".") ? name.split(".").pop()! : null;
  return {
    name,
    path,
    kind,
    size: kind === "file" ? 1234 : null,
    modified: 0,
    extension: ext,
    hidden: false,
  };
}

const FS: Record<string, FileEntry[]> = {
  "/home/u": [
    entry("/home/u/Documents", "directory"),
    entry("/home/u/Music", "directory"),
    entry("/home/u/notes.txt"),
    entry("/home/u/report.pdf"),
  ],
  "/home/u/Documents": [entry("/home/u/Documents/cv.pdf")],
  "/home/u/Music": [],
};

function listing(path: string): DirectoryListing {
  const parts = path.split("/").filter(Boolean);
  const breadcrumbs = [{ name: "/", path: "/" }].concat(
    parts.map((name, i) => ({ name, path: "/" + parts.slice(0, i + 1).join("/") })),
  );
  return {
    path,
    name: parts[parts.length - 1] ?? "/",
    parent: parts.length ? "/" + parts.slice(0, -1).join("/") : null,
    breadcrumbs,
    entries: FS[path],
  };
}

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];
let app: App | null = null;

async function mount(): Promise<void> {
  app?.dispose();
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, "");
  app = bootstrap();
  await app.start();
}

/** Paths bookmarked through `execute_operation` in the current test. */
const bookmarked = new Set<string>();

function installBackend(): void {
  calls = [];
  bookmarked.clear();
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      switch (cmd) {
        case "initial_location":
          return "/home/u";
        case "read_directory": {
          const path = (a.path as string).replace(/(.)\/$/, "$1");
          if (path === "/home/u/Secret") {
            throw { kind: "permissionDenied", path, message: "denied" };
          }
          return listing(path);
        }
        case "resolve_location": {
          const input = (a.input as string).replace(/^~/, "/home/u");
          if (FS[input]) return { path: input, isDirectory: true };
          const dir = input.slice(0, input.lastIndexOf("/"));
          if (FS[dir]?.some((e) => e.path === input)) return { path: input, isDirectory: false };
          throw { kind: "notFound", path: input, message: "missing" };
        }
        case "search_files": {
          if (a.query === "many") {
            const total = 250;
            const count = Math.min(a.limit as number, total);
            const hits = Array.from({ length: count }, (_, i) => ({
              ...entry(`/home/u/Music/track${i}.mp3`),
              parent: "/home/u/Music",
            }));
            return { hits, total, truncated: count < total };
          }
          return {
            hits: [
              { ...entry("/home/u/Documents", "directory"), parent: "/home/u" },
              { ...entry("/home/u/Documents/cv.pdf"), parent: "/home/u/Documents" },
            ],
            total: 2,
            truncated: false,
          };
        }
        case "execute_operation": {
          const name = (a.path as string).split("/").pop();
          if ((a.operation as { type: string }).type === "bookmark") {
            const added = !bookmarked.has(a.path as string);
            bookmarked.add(a.path as string);
            return { type: "bookmarked", name, added };
          }
          return { type: "deleted", name: "notes.txt" };
        }
        case "remove_bookmark":
          return bookmarked.delete(a.path as string);
        case "list_bookmarks":
          return [
            { name: "Music", path: "/home/u/Music", isDirectory: true },
            { name: "cv.pdf", path: "/home/u/Documents/cv.pdf", isDirectory: false },
          ];
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}

const tree = () => document.getElementById("file-list")!;
const rows = () => Array.from(tree().querySelectorAll<HTMLElement>("[role=treeitem]"));
const focused = () => document.activeElement as HTMLElement;
const status = () => document.getElementById("status-announcer")!.textContent;
const alert = () => document.getElementById("error-announcer")!.textContent;

function key(target: Element, k: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
  );
}

async function until(check: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  installBackend();
  await mount();
  await until(() => rows().length > 0 && rows()[0].getAttribute("aria-label") === "Documents");
});

afterEach(() => {
  app?.dispose();
  app = null;
  clearMocks();
});

describe("browse mode", () => {
  it("renders an ARIA tree with positional info and focuses the first item", () => {
    const items = rows();
    expect(tree().getAttribute("aria-label")).toBe("Contents of u");
    expect(items.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Documents",
      "Music",
      "notes.txt",
      "report.pdf",
    ]);
    expect(items[0].getAttribute("aria-posinset")).toBe("1");
    expect(items[0].getAttribute("aria-setsize")).toBe("4");
    expect(items[0].getAttribute("aria-expanded")).toBe("false");
    expect(items[2].hasAttribute("aria-expanded")).toBe(false);
    expect(focused()).toBe(items[0]);
    expect(items[0].getAttribute("aria-selected")).toBe("true");
  });

  it("links metadata via aria-describedby", () => {
    const pdf = rows()[3];
    const meta = document.getElementById(pdf.getAttribute("aria-describedby")!);
    expect(meta?.textContent).toContain("PDF file");
  });

  it("has no axe-core accessibility violations", async () => {
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } }, // no layout in jsdom
    });
    expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("moves with arrows, enters folders and returns focus when going up", async () => {
    key(focused(), "ArrowDown");
    expect(focused().getAttribute("aria-label")).toBe("Music");
    key(focused(), "ArrowUp");
    key(focused(), "Enter");
    await until(() => tree().getAttribute("aria-label") === "Contents of Documents");
    expect(focused().getAttribute("aria-label")).toBe("cv.pdf");
    await until(() => status() === "Documents, 1 items");

    key(focused(), "Backspace");
    await until(() => tree().getAttribute("aria-label") === "Contents of u");
    expect(focused().getAttribute("aria-label")).toBe("Documents");
  });

  it("supports first-letter navigation with typed prefixes", () => {
    key(focused(), "r");
    expect(focused().getAttribute("aria-label")).toBe("report.pdf");
    key(focused(), "n");
    // "rn" matches nothing, so focus stays.
    expect(focused().getAttribute("aria-label")).toBe("report.pdf");
  });

  it("announces empty folders", async () => {
    key(focused(), "m");
    key(focused(), "Enter");
    await until(() => rows()[0]?.getAttribute("aria-label") === "This folder is empty");
    await until(() => status() === "Music, empty");
  });

  it("announces the location on Ctrl+L", async () => {
    key(focused(), "l", { ctrlKey: true });
    await until(() => status() === "Current location: Root / home / u");
  });

  it("reports permission errors assertively", async () => {
    FS["/home/u"].push(entry("/home/u/Secret", "directory"));
    await mount(); // reload so the new folder is listed
    await until(() => rows().length === 5);
    key(focused(), "End");
    key(focused(), "Enter");
    await until(() => alert() === "Access denied to Secret.");
    FS["/home/u"].pop();
  });
});

describe("popups", () => {
  const searchInput = () => document.getElementById("search-input") as HTMLInputElement;
  const searchDialog = () => document.getElementById("search-dialog") as HTMLDialogElement;
  const results = () =>
    Array.from(document.querySelectorAll<HTMLElement>("#search-results [role=option]"));

  it("search: Enter shows the results in the popup, the list stays as it was", async () => {
    key(focused(), "f", { ctrlKey: true });
    const input = searchInput();
    expect(focused()).toBe(input);
    expect(input.getAttribute("role")).toBe("combobox");

    input.value = "cv";
    key(input, "Enter");
    await until(() => results().length === 2);
    await until(() => status() === "2 results");
    expect(calls.find((c) => c.cmd === "search_files")?.args).toMatchObject({
      scope: "/home/u",
      query: "cv",
    });
    expect(searchDialog().open).toBe(true);
    expect(focused()).toBe(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(results().map((r) => r.dataset.kind)).toEqual(["directory", "file"]);
    expect(results()[1].getAttribute("aria-label")).toContain("in /home/u/Documents");
    expect(tree().getAttribute("aria-label")).toBe("Contents of u");
  });

  it("search: arrows pick a result; Enter on a file opens its folder with it focused", async () => {
    key(focused(), "f", { ctrlKey: true });
    const input = searchInput();
    input.value = "cv";
    key(input, "Enter");
    await until(() => results().length === 2);
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe("search-result-1");
    expect(results()[1].getAttribute("aria-selected")).toBe("true");
    key(input, "Enter");
    expect(searchDialog().open).toBe(false);
    await until(() => focused().getAttribute?.("aria-label") === "cv.pdf");
    expect(tree().getAttribute("aria-label")).toBe("Contents of Documents");
  });

  it("search: a folder result opens the folder", async () => {
    key(focused(), "f", { ctrlKey: true });
    searchInput().value = "cv";
    key(searchInput(), "Enter");
    await until(() => results().length === 2);
    key(searchInput(), "ArrowDown");
    key(searchInput(), "Enter");
    await until(() => tree().getAttribute("aria-label") === "Contents of Documents");
  });

  it("search: 'show more' loads the next page and continues at the first new hit", async () => {
    key(focused(), "f", { ctrlKey: true });
    searchInput().value = "many";
    key(searchInput(), "Enter");
    await until(() => results().length === 201);
    expect(results()[200].textContent).toBe("Show more results (200 of 250)");
    key(searchInput(), "ArrowUp"); // wraps to "show more"
    key(searchInput(), "Enter");
    await until(() => results().length === 250);
    expect(searchInput().getAttribute("aria-activedescendant")).toBe("search-result-200");
  });

  it("search: a typed path goes there instead of searching", async () => {
    key(focused(), "f", { ctrlKey: true });
    searchInput().value = "~/Music";
    key(searchInput(), "Enter");
    expect(searchDialog().open).toBe(false);
    await until(() => tree().getAttribute("aria-label") === "Contents of Music");
    expect(calls.some((c) => c.cmd === "search_files")).toBe(false);
  });

  it("search: Escape in the popup returns focus without searching", () => {
    const before = focused();
    key(before, "f", { ctrlKey: true });
    const dialog = document.getElementById("search-dialog") as HTMLDialogElement;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(dialog.open).toBe(false);
    expect(focused()).toBe(before);
  });

  it("Escape pressed inside each popup closes it and restores focus", async () => {
    const before = focused();
    const popups: [string, KeyboardEventInit, string][] = [
      ["f", { ctrlKey: true }, "search-dialog"],
      ["k", { ctrlKey: true }, "palette-dialog"],
      ["F10", { shiftKey: true }, "context-dialog"],
      ["ContextMenu", {}, "context-dialog"],
      ["b", { ctrlKey: true }, "bookmarks-dialog"],
    ];
    for (const [k, init, id] of popups) {
      key(before, k, init);
      const dialog = document.getElementById(id) as HTMLDialogElement;
      await until(() => dialog.open);
      key(focused(), "Escape");
      expect(dialog.open).toBe(false);
      expect(focused()).toBe(before);
    }
  });

  it("each popup's shortcut pressed again closes it and restores focus", async () => {
    const before = focused();
    const popups: [string, KeyboardEventInit, string][] = [
      ["f", { ctrlKey: true }, "search-dialog"],
      ["k", { ctrlKey: true }, "palette-dialog"],
      ["F10", { shiftKey: true }, "context-dialog"],
      ["ContextMenu", {}, "context-dialog"],
      ["b", { ctrlKey: true }, "bookmarks-dialog"],
    ];
    for (const [k, init, id] of popups) {
      key(before, k, init);
      const dialog = document.getElementById(id) as HTMLDialogElement;
      await until(() => dialog.open);
      key(focused(), k, init);
      expect(dialog.open).toBe(false);
      expect(focused()).toBe(before);
    }
  });

  it("another popup's shortcut does nothing while a popup is open", async () => {
    key(focused(), "f", { ctrlKey: true });
    const search = document.getElementById("search-dialog") as HTMLDialogElement;
    key(focused(), "b", { ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(search.open).toBe(true);
    expect((document.getElementById("bookmarks-dialog") as HTMLDialogElement).open).toBe(false);
  });

  it("palette: arrow down on empty input lists all operations", () => {
    key(focused(), "k", { ctrlKey: true });
    const input = document.getElementById("palette-input")!;
    expect(focused()).toBe(input);
    key(input, "ArrowDown");
    const options = Array.from(document.querySelectorAll("#palette-list [role=option]")).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["Open", "Copy", "Cut", "Paste", "Delete", "Rename", "Add bookmark"]);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-open");
  });

  it("palette: typing filters and Enter executes on the focused item", async () => {
    key(focused(), "ArrowDown");
    key(focused(), "ArrowDown"); // notes.txt
    key(focused(), "k", { ctrlKey: true });
    const input = document.getElementById("palette-input") as HTMLInputElement;
    input.value = "del";
    input.dispatchEvent(new Event("input"));
    const options = Array.from(document.querySelectorAll("#palette-list [role=option]")).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["Delete"]);
    key(input, "Enter");
    await until(() => calls.some((c) => c.cmd === "execute_operation"));
    expect(calls.find((c) => c.cmd === "execute_operation")?.args).toEqual({
      operation: { type: "delete" },
      path: "/home/u/notes.txt",
    });
    await until(() => status() === "Moved notes.txt to the trash");
  });

  const menuItems = () =>
    Array.from(document.querySelectorAll<HTMLElement>("#context-menu [role=menuitem]"));
  const contextDialog = () => document.getElementById("context-dialog") as HTMLDialogElement;

  it("context menu: Shift+F10 opens it on the focused row with focus on the first item", () => {
    key(focused(), "F10", { shiftKey: true });
    expect(contextDialog().open).toBe(true);
    expect(menuItems().map((i) => i.textContent)).toEqual([
      "Open",
      "Cut",
      "Copy",
      "Paste",
      "Rename",
      "Delete",
    ]);
    expect(document.getElementById("context-menu")!.getAttribute("aria-label")).toBe(
      "Actions for Documents",
    );
    expect(focused()).toBe(menuItems()[0]);
    key(focused(), "End");
    expect(focused().textContent).toBe("Delete");
    key(focused(), "ArrowDown"); // wraps
    expect(focused().textContent).toBe("Open");
    key(focused(), "r"); // jump key
    expect(focused().textContent).toBe("Rename");
  });

  it("context menu: fixed keys jump to their item (C copy, X cut, V paste…)", () => {
    key(focused(), "F10", { shiftKey: true });
    const jumps: [string, string][] = [
      ["c", "Copy"],
      ["x", "Cut"],
      ["v", "Paste"],
      ["d", "Delete"],
      ["o", "Open"],
      ["C", "Copy"], // with Caps Lock or Shift
    ];
    for (const [k, label] of jumps) {
      key(focused(), k);
      expect(focused().textContent).toBe(label);
    }
    expect(menuItems().map((i) => i.getAttribute("aria-keyshortcuts"))).toEqual([
      "O",
      "X",
      "C",
      "V",
      "R",
      "D",
    ]);
    expect(contextDialog().open).toBe(true); // jumping does not run anything
    expect(calls.some((c) => c.cmd === "execute_operation")).toBe(false);
  });

  it("context menu: Enter runs the item on the focused file", async () => {
    key(focused(), "ArrowDown");
    key(focused(), "ArrowDown"); // notes.txt
    key(focused(), "ContextMenu");
    key(focused(), "End"); // Delete
    key(focused(), "Enter");
    expect(contextDialog().open).toBe(false);
    await until(() => status() === "Moved notes.txt to the trash");
    expect(calls.find((c) => c.cmd === "execute_operation")?.args).toEqual({
      operation: { type: "delete" },
      path: "/home/u/notes.txt",
    });
  });

  it("context menu: right click selects the row and opens the menu there", () => {
    const row = rows()[2]; // notes.txt
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
    );
    expect(contextDialog().open).toBe(true);
    expect(rows()[2].getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("context-menu")!.getAttribute("aria-label")).toBe(
      "Actions for notes.txt",
    );
  });

  it("context menu: right click on empty space offers only Paste", () => {
    tree().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const enabled = menuItems().filter((i) => i.getAttribute("aria-disabled") !== "true");
    expect(enabled.map((i) => i.textContent)).toEqual(["Paste"]);
    expect(focused().textContent).toBe("Paste");
  });

  it("context menu: Rename asks for the new name in the palette prompt", async () => {
    key(focused(), "F10", { shiftKey: true });
    key(focused(), "r");
    key(focused(), "Enter");
    const input = document.getElementById("palette-input") as HTMLInputElement;
    expect(focused()).toBe(input);
    expect(input.value).toBe("Documents");
    input.value = "Papers";
    key(input, "Enter");
    await until(() => calls.some((c) => c.cmd === "execute_operation"));
    expect(calls.find((c) => c.cmd === "execute_operation")?.args).toEqual({
      operation: { type: "rename", newName: "Papers" },
      path: "/home/u/Documents",
    });
  });

  it("bookmarks: Ctrl+B lists bookmarks and Enter navigates", async () => {
    key(focused(), "b", { ctrlKey: true });
    await until(() => (document.getElementById("bookmarks-dialog") as HTMLDialogElement).open);
    const list = document.getElementById("bookmarks-list")!;
    expect(focused()).toBe(list);
    expect(list.getAttribute("aria-activedescendant")).toBe("bookmark-0");
    key(list, "Enter");
    await until(() => tree().getAttribute("aria-label") === "Contents of Music");
  });

  it("bookmarks: Ctrl+D bookmarks the focused file", async () => {
    key(focused(), "ArrowDown");
    key(focused(), "ArrowDown"); // notes.txt
    key(focused(), "d", { ctrlKey: true });
    await until(() => status() === "Bookmarked notes.txt");
    expect(calls.find((c) => c.cmd === "execute_operation")?.args).toEqual({
      operation: { type: "bookmark" },
      path: "/home/u/notes.txt",
    });
  });

  it("bookmarks: Ctrl+D in the list removes the selected bookmark", async () => {
    key(focused(), "b", { ctrlKey: true });
    const list = document.getElementById("bookmarks-list")!;
    await until(() => list.querySelectorAll("[role=option]").length === 2);
    key(list, "ArrowDown"); // cv.pdf
    key(list, "d", { ctrlKey: true });
    await until(() => status() === "Removed bookmark cv.pdf");
    expect(calls.find((c) => c.cmd === "remove_bookmark")?.args).toEqual({
      path: "/home/u/Documents/cv.pdf",
    });
    await until(() => list.querySelectorAll("[role=option]").length === 1);
    expect(list.getAttribute("aria-activedescendant")).toBe("bookmark-0");
    expect((document.getElementById("bookmarks-dialog") as HTMLDialogElement).open).toBe(true);
  });

  it("bookmarks: Ctrl+D again removes the bookmark", async () => {
    key(focused(), "ArrowDown");
    key(focused(), "ArrowDown"); // notes.txt
    key(focused(), "d", { ctrlKey: true });
    await until(() => status() === "Bookmarked notes.txt");
    key(focused(), "d", { ctrlKey: true });
    await until(() => status() === "Removed bookmark notes.txt");
    expect(calls.find((c) => c.cmd === "remove_bookmark")?.args).toEqual({
      path: "/home/u/notes.txt",
    });
    expect(bookmarked.has("/home/u/notes.txt")).toBe(false);
  });

  it("bookmarks: a file bookmark opens its folder with the file focused", async () => {
    key(focused(), "b", { ctrlKey: true });
    const list = document.getElementById("bookmarks-list")!;
    await until(() => list.querySelectorAll("[role=option]").length === 2);
    const kinds = Array.from(list.querySelectorAll<HTMLElement>("[role=option]")).map(
      (o) => o.dataset.kind,
    );
    expect(kinds).toEqual(["directory", "file"]);
    key(list, "ArrowDown");
    key(list, "Enter");
    await until(() => focused().getAttribute?.("aria-label") === "cv.pdf");
    expect(tree().getAttribute("aria-label")).toBe("Contents of Documents");
  });
});

describe("location box", () => {
  const field = () => document.getElementById("breadcrumbs")!;
  const box = () => document.getElementById("location-input") as HTMLInputElement;

  it("clicking the field opens it with the current path selected", () => {
    field().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(field().hidden).toBe(true);
    expect(focused()).toBe(box());
    expect(box().value).toBe("/home/u");
    expect(box().getAttribute("aria-label")).toBe("Type a location");
  });

  it("inside home the path starts at Home, and segments still navigate", async () => {
    key(focused(), "Enter"); // into Documents
    await until(() => tree().getAttribute("aria-label") === "Contents of Documents");
    const crumbs = Array.from(field().querySelectorAll("button"));
    expect(crumbs.map((b) => b.textContent)).toEqual(["Home", "Documents"]);
    crumbs[0].click();
    expect(box().hidden).toBe(true);
    await until(() => tree().getAttribute("aria-label") === "Contents of u");
  });

  it("Enter opens the typed folder, relative to the current one", async () => {
    field().click();
    box().value = "Music";
    key(box(), "Enter");
    await until(() => tree().getAttribute("aria-label") === "Contents of Music");
    expect(box().hidden).toBe(true);
    expect(field().hidden).toBe(false);
  });

  it("a typed file opens its folder with the file focused", async () => {
    field().click();
    box().value = "~/Documents/cv.pdf";
    key(box(), "Enter");
    await until(() => focused().getAttribute?.("aria-label") === "cv.pdf");
  });

  it("an unknown path is announced and the box stays open", async () => {
    field().click();
    box().value = "/nowhere";
    key(box(), "Enter");
    await until(() => alert() === "nowhere was not found.");
    expect(box().hidden).toBe(false);
    expect(focused()).toBe(box());
  });

  it('"/" in the list opens the box with "/" typed', () => {
    key(focused(), "/");
    expect(focused()).toBe(box());
    expect(box().value).toBe("/");
  });

  it("Escape restores the path and returns to the list", () => {
    field().click();
    key(box(), "Escape");
    expect(box().hidden).toBe(true);
    expect(tree().contains(focused())).toBe(true);
  });
});
