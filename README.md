# Accex

Accex is a file explorer for people who use a screen reader.

Most file explorers are built for the eye: sidebars, toolbars, ribbons,
preview panes, several regions competing for attention. With a screen reader,
every one of those regions is something to tab through, remember, and get lost
in. Accex goes the other way. There is exactly one layout — where you are, then
what's in it — and it never changes. Everything else (search, bookmarks,
commands, settings) is a popup that takes focus when it opens and gives it back
when it closes.

Accex never speaks on its own. It has no text-to-speech engine and plays no
sounds. It exposes a correct, semantic accessibility tree through the
operating system's native webview, and your screen reader — NVDA, JAWS,
VoiceOver, or Orca — does the talking, with your voice, your speed, and your
verbosity settings.

```
[ Current location: Home / Documents / Projects ]
[ file or folder 1                              ]
[ file or folder 2                              ]
[ file or folder 3                              ]
```

## Project Status

Accex is **pre-release** (version 0.1.0). The core of the v1 feature set is
implemented, but there are no published binaries yet and you'll need to build
it yourself. Expect rough edges and breaking changes.

| Feature                                        | Status |
| ---------------------------------------------- | ------ |
| Keyboard browsing, breadcrumbs, type-to-jump   | ✅     |
| Live updates when folder contents change       | ✅     |
| Search (plain and natural-language queries)    | ✅     |
| Context menu and command palette               | ✅     |
| Copy, cut, paste, rename, delete (to trash)    | ✅     |
| Bookmarks                                      | ✅     |
| Configurable keyboard shortcuts                | ✅     |
| English and German UI                          | ✅     |
| Verified on all three platforms                | ⚠️     |
| End-to-end tests with `tauri-driver`           | ❌     |
| Prebuilt releases                              | ❌     |

## Using Accex

Accex opens in your home folder. The location is always the first thing on
screen; the folder contents follow as a tree. Arrow keys move through the list,
`Enter` opens, and typing a letter jumps to the next entry starting with it.
Each entry's name is its label; type, size and modification date are attached
as a description, so your screen reader only reads them when you ask.

### Keyboard Shortcuts

| Action                       | Default                                          |
| ---------------------------- | ------------------------------------------------ |
| Move through the list        | `Up` / `Down`                                    |
| Jump to entry by first letter| `A`–`Z`                                          |
| Open folder or file          | `Enter`                                          |
| Go up one level              | `Left`, `Backspace`, `Alt+Up`, or `Cmd+Up`       |
| Type a location              | `/` (`Enter` goes there, `Escape` cancels)       |
| Announce current location    | `Ctrl+L`                                         |
| Search                       | `Ctrl+F`                                         |
| Context menu                 | `Shift+F10`, the `Apps` key, or right click      |
| Command palette              | `Ctrl+K`                                         |
| Bookmarks                    | `Ctrl+B`                                         |
| Bookmark / unbookmark        | `Ctrl+D`                                         |
| Settings                     | `Ctrl+S`                                         |
| Close any popup              | `Escape`, or the shortcut that opened it         |

Every shortcut that opens something can be changed under **Settings → Keyboard
shortcuts**. `Enter` records a new combination, `Delete` resets one, and
"Reset all shortcuts" restores the defaults. A combination needs `Ctrl` or
`Alt` (function keys and `/` work alone), `Ctrl+A/C/V/X/Y/Z` stay reserved for
editing text, and no two actions can share a combination.

### Search

`Ctrl+F` opens a search field near the top of the window. Results load when
you press `Enter` — not while you type — and the number of results is
announced. Arrow keys move through them while focus stays in the field.
`Enter` on a folder opens it; `Enter` on a file opens its folder with the file
focused. Typing a path (`/…` or `~/…`) navigates there instead of searching.

Search covers the current folder and two levels below it, merged with matches
from folders you've visited before. Results come in pages of 200.

Beyond plain name fragments, search understands a few words in English and
German:

```
*.rs
pdf invoices
images from holiday
folders named projects
zeige alle bilder vom urlaub
```

### Context Menu and Command Palette

The context menu offers **Open · Cut, Copy, Paste · Rename, Delete**.
Operations that don't apply are shown but disabled. Each item has a fixed
jump key that is the same in every language: `O`, `X`, `C`, `V`, `R`, `D`.

The command palette (`Ctrl+K`) does the same by name: type `cop`, `ren`,
`del` and pick a suggestion. Pressing `Down` in an empty palette lists every
operation, so you never have to memorize them.

Delete moves items to the system trash. Every operation reports its result
through a polite live region; errors use an assertive one.

### Behavior Worth Knowing

- Symbolic links are listed but never followed.
- Hidden files are not shown.
- If the current folder disappears (for example, a drive is unplugged), Accex
  falls back to the nearest folder that still exists, or your home folder.
- The UI language follows your system locale and falls back to English.

## Building

There are no prebuilt binaries yet. You'll need:

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) with npm
- The [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for
  your platform. On Debian/Ubuntu:

  ```
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  On Windows, the WebView2 runtime (preinstalled on Windows 11).

Then:

```
git clone git@github.com:lynx5001/File-explorer.git accex
cd accex
npm install
npm run tauri dev      # run in development mode
npm run tauri build    # build an installable release
```

Release bundles end up in `src-tauri/target/release/bundle/`.

## Where Accex Keeps Its Data

Accex uses the standard per-platform directories for the identifier
`org.lynx5001.accex`.

- **Config** — bookmarks and changed shortcuts, as `config.json` in the
  platform config directory (e.g. `~/.config/org.lynx5001.accex/` on Linux).
- **Search cache** — `index.sqlite` in the platform cache directory, holding
  the folders you've visited. It's only a cache; deleting it is safe.
- **Logs** — daily rotating `accex.log` files in the platform log directory.
  Release builds don't log file names.

## Developing Accex

Accex is a [Tauri v2](https://v2.tauri.app) app. The split is strict:

- **Engine** (`src-tauri/`, Rust) owns everything that touches the disk:
  listing, file operations, the `notify`-based folder watcher, the search
  walker and its SQLite cache, and config persistence. It knows nothing about
  the UI.
- **Surface** (`src/`, TypeScript, no framework) is semantic HTML with ARIA.
  It owns focus management, live-region announcements, and translations. It
  never touches the file system directly.
- **Bridge** — the Tauri commands in `src-tauri/src/lib.rs` and their typed
  wrappers in `src/bridge/`. Changes to the contract start here, on both
  sides at once.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full layout and
[accessibility.md](accessibility.md) for the accessibility rules every UI
change has to follow.

### Checks

Every change should pass these before it's committed:

```
npm run lint && npm run format:check && npm run typecheck && npm test
cd src-tauri && cargo fmt --check && cargo clippy && cargo test
```

`npm test` runs the real `index.html` in jsdom against a mocked IPC bridge
and audits it with axe-core. Rust tests live next to the code and use
temporary directories, never your real files.

Automated tests are not enough for this project. Any change to the UI must
also be tried with a real screen reader and without a mouse. If you can only
test one, tell us which one in your pull request.

### Ground Rules

These are the decisions the rest of the project is built on. Changes that
break them won't be merged.

- **No custom speech.** The screen reader does all output.
- **One layout.** No sidebars, panels or toolbars. New features are popups
  that take focus and return it.
- **Keyboard first.** Every action has a shortcut. Focus indicators are never
  hidden.
- **No hardcoded strings.** Everything user-facing, including ARIA labels, goes
  through `src/i18n/`.
- **No shell.** The command palette calls Rust functions, never shell commands.
  No remote scripts are ever loaded into the webview.
- **WCAG 2.2 AA** is the minimum bar.

### Performance Targets

- Interactive in under 500 ms from a cold start.
- Folders with fewer than 5,000 entries render in under 100 ms. Larger
  folders stay usable because the list is virtualized.
- Under 100 MB of memory at rest.

## Not Planned for 1.0

To keep the first version focused, these are deliberately out of scope:
built-in text-to-speech, voice input, multi-file selection, file previews,
and network or cloud locations.

## Platform Support

| Platform        | Webview          | Screen readers |
| --------------- | ---------------- | -------------- |
| Linux           | WebKitGTK        | Orca           |
| Windows 10 / 11 | WebView2         | NVDA, JAWS     |
| macOS           | WKWebView        | VoiceOver      |

## License

Accex does not have a license yet. Until one is added, all rights are
reserved.
