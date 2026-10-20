# Architecture: Engine vs. Surface

This project follows a strict separation between the **Engine** (Rust) and the **Surface** (Tauri/HTML).

## Project Structure

```text
.
├── .gemini/                  # AI Guardrails
│   └── rules/
│       └── ipc.md            # Bridge-first development rules
├── docs/                     # Detailed technical documentation
├── src/                      # THE SURFACE (Frontend - TS/HTML/CSS)
│   ├── accessibility/        # A11y services
│   │   ├── announcer.ts      # ARIA live region management
│   │   └── focus-manager.ts  # Focus trap/restoration logic
│   ├── bridge/               # IPC implementation
│   │   ├── commands.ts       # Tauri invoke wrappers
│   │   └── types.ts          # Shared TS/Rust types
│   ├── components/           # Semantic UI elements
│   │   ├── breadcrumbs/      # Path navigation
│   │   ├── context-menu/     # Right-click / Apps-key menu (role="menu")
│   │   ├── search/           # Search popup (combobox + results listbox)
│   │   └── tree/             # File list (role="tree")
│   ├── i18n/                 # Localization
│   ├── styles/               # Accessibility-focused CSS
│   └── main.ts               # Frontend entry point

├── src-tauri/                # THE ENGINE (Backend - Rust)
│   ├── migrations/           # SQLite schema migrations
│   ├── src/
│   │   ├── engine/           # Domain Logic (UI-agnostic)
│   │   │   ├── search/       # SQLite indexing logic
│   │   │   ├── bookmarks.rs  # Persistence logic
│   │   │   ├── fs.rs         # File system operations
│   │   │   ├── mod.rs
│   │   │   └── watcher.rs    # notify-rs integration
│   │   ├── error.rs          # Unified Error handling
│   │   ├── lib.rs            # THE BRIDGE (IPC Command definitions)
│   │   ├── main.rs           # App setup and lifecycle
│   │   └── state.rs          # Shared AppState
│   ├── Cargo.lock            # Exact dependency versions (Crucial for reproducible builds)
│   ├── Cargo.toml
│   └── tauri.conf.json       # Tauri app configuration

├── tests/                    # E2E and integration tests
├── .gitignore                # Git exclusion rules
├── .goosyignore                # Goosy exclusion rules
├── accessibility.md          # Specific A11y implementation rules
├── ARCHITECTURE.md           # Architecture overview (This file)
├── GEMINI.md                 # High-priority AI context
├── index.html                # Surface entry point (Semantic Skeleton)
├── package.json              # Frontend dependencies and scripts
├── README.md                 # Project vision and roadmap
├── tsconfig.json             # TypeScript configuration
├── tsconfig.node.json        # 
└── vite.config.ts            # Vite configuration
```

## 1. The Engine (src-tauri/src/engine)
- **Location:** `src-tauri/`
- **Purpose:** Contains all the core business logic, file system operations, search indexing, and real-time watchers. It is designed to be platform-agnostic and UI-agnostic.
- **Key Components:**
    - `src-tauri/src/main.rs`: Tauri application entry point, handles window setup and lifecycle.
    - `src-tauri/src/lib.rs`: The "Bridge" layer, exposing Rust functions as Tauri commands.
    - `src-tauri/src/engine/`:
        - `fs.rs`: File system abstraction, path handling, metadata extraction.
        - `search/`: SQLite database management, flat-walk indexing logic.
        - `watcher.rs`: Integrates `notify` crate for real-time file system events.
        - `bookmarks.rs`: Persistence logic for user bookmarks.
    - `src-tauri/src/state.rs`: Manages shared application state (e.g., current directory, bookmarks).
    - `src-tauri/src/error.rs`: Custom error types for robust error handling.
    - `src-tauri/migrations/`: SQLite schema migrations for the search index.

## 2. The Surface (src/)
- **Location:** `src/`
- **Purpose:** The user interface layer, built with semantic HTML, CSS, and TypeScript. It consumes data from the Rust engine via Tauri commands and emits events.
- **Key Components:**
    - `src/main.ts`: Frontend application initialization.
    - `src/bridge/`:
        - `commands.ts`: TypeScript wrappers for calling Tauri commands.
        - `types.ts`: TypeScript interfaces mirroring Rust data structures for type safety across the IPC bridge.
    - `src/components/`: Reusable UI components built with semantic HTML and ARIA roles.
        - `tree/`: Implements `role="tree"` for the file list.
        - `search/`: The search popup: a `combobox` with a `listbox` of results below it.
        - `context-menu/`: The context menu (`role="menu"`) for file operations, opened at the pointer or the focused row.
        - `breadcrumbs/`: Displays the current path.
    - `src/accessibility/`: Dedicated modules for accessibility features.
        - `focus-manager.ts`: Handles focus traps, restoration, and keyboard navigation.
        - `announcer.ts`: Manages `aria-live` regions for screen reader announcements.
    - `src/i18n/`: Internationalization resources (translation keys).
    - `src/styles/`: Minimal CSS for layout and accessibility-focused styling (e.g., focus indicators).

## 3. Documentation & Configuration
- `.gemini/`: AI-specific rules and configurations.
- `docs/`: Additional architectural and design documentation.
- `tests/ui/`: Frontend integration tests (vitest + jsdom + axe-core) running the real `index.html` against a mocked IPC bridge. Run with `npm test`.
- Rust unit tests live next to the code (`#[cfg(test)]`); run with `cargo test` in `src-tauri/`.
- `tests/e2e/` (planned): End-to-end tests using `tauri-driver`.

- **Pure Logic:** Handles file system I/O, SQLite indexing, and path manipulation.
- **Agnostic:** The engine must not know about Tauri, HTML, or JSON. It returns Rust results and types.
- **Concurrency:** Uses tokio/channels to manage heavy tasks (like deep-walk indexing) without blocking the UI.

## 2. The Bridge (src-tauri/src/lib.rs)
- **IPC Layer:** Translates Tauri commands into Engine calls.
- **Security:** This is the only place where path validation and canonicalization happen.
- **Events:** Uses `window.emit` to push file system changes from the `notify` watcher to the frontend.

## 3. The Surface (src/)
- **Semantic HTML:** The UI is a skeletal structure of ARIA roles (`tree`, `treeitem`, `combobox`, `listbox`).
- **State Management:** The frontend tracks focus and "expanded" states, mirroring the engine's data.
- **Zero Canvas:** Under no circumstances should GPU-accelerated canvases or custom-drawn components be used for primary navigation elements.

## Data Flow
1. User presses `Enter` (Surface).
2. Surface sends `read_directory` command (Bridge).
3. Bridge validates path (`engine::fs::resolve_directory`) and calls `engine::fs::list_directory` (Engine).
4. Engine returns `Vec<FileEntry>` (Engine).
5. Bridge serializes to JSON and returns to Surface.
6. Surface updates ARIA tree and moves focus (Surface).

## IPC Contract (src-tauri/src/lib.rs ↔ src/bridge/)

| Command | Arguments | Returns |
|---|---|---|
| `initial_location` | – | home path |
| `read_directory` | `path`, `showHidden` | `DirectoryListing` (also caches the folder in SQLite and starts watching it) |
| `fallback_directory` | `path` | nearest existing ancestor (disk unplugged) |
| `resolve_location` | `input` | `ResolvedLocation` (canonicalized, must exist) |
| `search_files` | `scope`, `query`, `limit`, `showHidden` | `SearchResults` (scope + 2 levels, plus cached deeper folders) |
| `execute_operation` | `operation`, `path` | `OperationOutcome` (open, copy, cut, paste, delete → trash, rename, bookmark) |
| `list_bookmarks` / `remove_bookmark` | – / `path` | `Bookmark[]` (`name`, `path`, `isDirectory`; folders first, then files, by name) / `bool` |

Event: `fs-change` with an `FsChange` payload whenever the watched folder changes.
Errors are serialized as `{ kind, path, message }`; the UI maps `kind` to the `error.*` i18n keys.
