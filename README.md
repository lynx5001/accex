# Accessible File Explorer

A high-efficiency, low-noise desktop file explorer optimized for screen reader users and keyboard-centric workflows. Unlike traditional explorers that present complex, multi-pane interfaces, this project focuses on a **predictable, single-stream layout** that minimizes cognitive load for blind and vision-impaired users. It delegates all speech output to the native OS accessibility layer (ARIA) to ensure a seamless experience with JAWS, NVDA, VoiceOver, and Orca.

---

## Developer Onboarding & Getting Started

### Prerequisites
- **Rust Toolchain:** Latest stable version.
- **Node.js & npm/pnpm:** Required for the Tauri frontend.
- **System Dependencies:**
  - **Linux:** `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.
  - **Windows:** WebView2 runtime.

### Quality Standards
- **Linting:** All Rust code must pass `cargo clippy`. Frontend code must pass `prettier --check`.
- **Formatting:** Run `cargo fmt` before every commit.
- **Documentation:** Public Rust modules and functions must be documented with `///` rustdocs.

### Setup
1. Clone the repository.
2. Install frontend dependencies: `npm install`.
3. Run in development mode: `npm run tauri dev`.
4. Build release: `npm run tauri build`.

---

## Development Methodology

The project follows a **Top-Down Decomposition** approach. Developers should avoid "bottom-up" coding (building isolated features first) and instead focus on defining the application's contract and flow.

### 1. Interface-First Definition (The Bridge)
Before implementing logic, define the communication layer between Rust and the Frontend.
- Define the Tauri Command signatures (e.g., `read_directory`, `execute_operation`).
- Define the TypeScript interfaces for the data models to ensure type safety across the IPC bridge.

### 2. Core Domain Logic (Rust Modules)
Implement the "Source of Truth" in the backend.
- **Sub-process A:** File System abstraction (handling paths, metadata).
- **Sub-process B:** The Watcher (handling real-time updates).
- **Sub-process C:** The Search Engine (SQLite & Flat-walk).

### 3. Structural UI (Accessibility First)
Build the UI "Skeleton" using semantic HTML before adding styles or complex state.
- Map the ARIA roles (`tree`, `searchbox`, `status`) to the data provided by the backend.
- Verify that a screen reader can "see" the structure even with zero CSS.

### 4. Incremental Feature Implementation
Implement features in vertical slices to maintain a working application at all times:
1. **Read-only Navigation:** Browsing folders and breadcrumbs.
2. **Focus Management:** Handling keyboard traps and popup transitions.
3. **Write Operations:** Delete, Copy, Paste (with `aria-live` feedback).
4. **Performance Optimization:** List virtualization and search indexing.

### Best Practices
- **Atomic Commits:** Each commit should represent a single logical change or sub-process.
- **Documentation-Driven:** Update the rustdocs or README when the internal API changes.
- **Failing-Test First:** For backend logic (e.g., path resolution), write a failing test case before implementing the fix.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Application shell | Tauri v2 |
| Backend / performance logic | Rust |
| UI / accessibility layer | HTML + CSS + JavaScript (semantic) |
| Accessibility tree | Native OS webview (WKWebView, WebView2, WebKitGTK) |
| File indexing | SQLite (via Rust) |
| Screen reader support | JAWS, VoiceOver, NVDA, Orca — via ARIA |

---

## Core Design Principles

- **Screen reader delegation** — the app produces no custom TTS or audio output. All announcements are handled by the user's existing screen reader via a correct semantic and ARIA structure.
- **One persistent layout** — current path is always at the top, file and folder contents always below. The screen reader never has to relearn the structure.
- **Keyboard first** — every action is reachable by shortcut. No mouse required.
- **Minimal UI surface** — no competing sidebars, panels, or toolbars. One focused region at a time.
- **Popup on demand** — search, context menu, and bookmarks appear as focused popups and dismiss back to the previous focus point.

---

## UI Model

### Layout (always)

```
[ Current location: Home / Documents / Projects ]
[ file or folder 1                              ]
[ file or folder 2                              ]
[ file or folder 3                              ]
[ ...                                           ]
```

The location breadcrumb is always the first element. Contents follow. This structure never changes regardless of browse or search state.

### Search bar (popup)
- Triggered by shortcut
- Focus jumps to input immediately on open
- Results load on `Enter` — no live update while typing
- Results replace the content area below the current path
- Each result shows: filename, full parent path, modified date, file type
- **Virtualization:** Uses high-performance list virtualization to handle 10,000+ items without lag.
- **Search Logic:** Initial v1 uses a flat-file walk; SQLite indexing is utilized for caching previously visited directories.
- A "more results" item appears at the bottom when results are truncated
- **Accessibility:** Announces result count via `aria-live` when results load.
- `Escape` dismisses and restores the previous content

### Context menu (popup, command palette style)
- Triggered by `Apps` key (Windows convention, familiar to JAWS users)
- Focus jumps to a text input immediately
- User types an operation (e.g. `cop`, `del`, `ren`) and suggestions appear live
- Arrow down to select a suggestion, `Enter` to execute
- If input is empty and user presses arrow down, all available operations are listed — for discoverability
- `Escape` dismisses without action

**v1 operations:**
- Open
- Copy
- Cut
- Paste
- Delete
- Rename
- Bookmark current path

### Bookmarks (popup)
- Triggered by shortcut
- List of saved locations, arrow to navigate, `Enter` to go there
- Bookmarks are created via the context menu ("Bookmark current path")
- `Escape` dismisses

---

## Keyboard Shortcuts (planned)

| Action | Shortcut |
|---|---|
| Navigate into folder | `Enter` |
| Go up one level | `Backspace` (Win), `Cmd + Up` (Mac), or `Alt + Up` |
| Open search bar | `Ctrl + F` |
| Open context menu | `Apps` key or `Shift + F10` |
| Open bookmarks | `Ctrl + B` |
| Announce current location | `Ctrl + L` (Status announcement) |
| Type a location | `/`, or click the location field (Enter to go, Escape to cancel) |
| Dismiss any popup | `Escape` |
| Jump to file | `A-Z` (First-letter navigation) |
| Move through file list | `Arrow Up / Down` |

---

## Accessibility Requirements

- `role="tree"` and `role="treeitem"` for the directory listing
- `role="searchbox"` for the search input
- `role="status"` or `aria-live="polite"` for search result updates and operation feedback
- `aria-live="assertive"` for errors only
- `aria-expanded` on folder items (collapsed / expanded state)
- `aria-posinset` and `aria-setsize` for all items in the file list (critical for virtualized lists)
- `aria-selected` to indicate the current focused file/folder
- `aria-describedby` for file metadata (size, date, type) per item
- `aria-label` on every interactive element — no unlabelled controls
- Focus moves automatically on popup open and returns to previous element on dismiss
- WCAG 2.2 AA compliance target

---

## Testing Strategy

To ensure the high accessibility and performance standards of this project, all contributions must adhere to the following testing pillars:

### 1. Accessibility Testing (Non-Negotiable)
- **Automated Audits:** Continuous integration must run `axe-core` or similar engines on the UI to catch semantic errors.
- **Manual Screen Reader Validation:** Every UI change must be verified with at least one native screen reader (NVDA/JAWS on Windows, VoiceOver on macOS, or Orca on Linux).
- **Keyboard-Only Navigation:** The application must be fully operable without a mouse or trackpad. Focus visible indicators must never be suppressed.

### 2. Cross-Platform UI Testing
- **Webview Consistency:** Since Tauri uses the OS-native webview, UI layouts must be tested on Windows (WebView2), macOS (WebKit), and Linux (WebKitGTK) to ensure consistent ARIA tree exposure.
- **End-to-End (E2E):** Use `tauri-driver` (WebDriver) to automate critical paths: searching for a file, navigating a directory, and opening the command palette.

### 3. Backend Logic Testing (Rust)
- **File Operations:** Unit tests for path canonicalization, safe file deletion, and recursive copying.
- **Search Indexing:** Integration tests for SQLite search performance and result ranking.
- **Mocking:** Use a temporary directory structure for filesystem tests to avoid side effects on the developer's machine.

### 4. Performance Regression
- Test directory listing speed with a mock folder containing 10,000+ empty files to ensure virtualization and IPC throughput remain within performance goals.

---

## Standard Practices

### 1. Internationalization (i18n)
All user-facing strings, including `aria-label` and `aria-description` content, must be externalized. The app will detect the OS locale and default to English if the translation is unavailable.

### 2. Logging & Observability
The backend uses the `tracing` crate for structured logging. Logs are stored in the platform-specific "logs" directory (e.g., `%AppData%\Local\accessible-explorer\logs` on Windows). PII (filenames) must be sanitized in production logs unless debug mode is active.

### 3. Configuration & State
App state (bookmarks, window position, user preferences) is stored in a JSON file within the platform's standard config directory. SQLite is strictly reserved for the search index and metadata cache, not for configuration.

---

## Technical Implementation Details

### 1. File System Watcher
The Rust backend utilizes the `notify` crate to monitor the currently viewed directory. Changes (created, deleted, renamed) must be pushed via Tauri events (`emit`) to the frontend to ensure the screen reader's view remains synchronized with the disk without manual refreshes.

### 2. Performance Goals
- **Cold Start:** UI should be interactive in < 500ms.
- **Directory Read:** Directories with < 5,000 items must render in < 100ms.
- **Memory usage:** Baseline < 100MB RAM.

### 3. Error Handling
- **Permission Denied:** Friendly `aria-live` announcement: "Access denied to [Folder Name]."
- **Disk Unplugged:** Graceful fallback to the nearest available parent directory or Home.
- **Validation:** All path inputs from the search bar must be canonicalized and checked for existence before navigation.

### 4. Security Considerations
- **Path Traversal:** The backend must validate that requested paths are within allowed scopes (OS-level permissions).
- **Command Injection:** The "Command Palette" executes internal Rust functions, never raw shell commands.
- **WebView Isolation:** No external scripts are loaded; `dangerousDisableAssetProtocolNetDoor` is kept `false`.

---

## Architecture

```
┌─────────────────────────────────────────┐
│              Input layer                │
│   Keyboard shortcuts · Apps key · Tab   │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│            Tauri v2 backend (Rust)      │
│  File system access · SQLite index      │
│  Search & path resolution · FS watcher  │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│         Frontend (HTML / ARIA)          │
│  Semantic structure · Focus management  │
│  ARIA live regions · Popup layer        │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│        OS native webview                │
│  WKWebView · WebView2 · WebKitGTK       │
│  Exposes full accessibility tree        │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│         Screen reader                   │
│  JAWS · VoiceOver · NVDA · Orca         │
│  Handles all audio output               │
└─────────────────────────────────────────┘
```

---

## v1 Scope

The first version focuses on core navigation and search. Everything listed below is in scope; nothing else is.

**In scope**
- Browse mode: navigate the file system with keyboard shortcuts
- Search popup: find files and folders by name or natural language description
- Context menu: command palette for file operations with `aria-live` feedback
- Bookmarks: save and jump to frequent locations
- Full screen reader compatibility via ARIA
- Cross-platform: Windows, macOS, Linux

**Explicitly out of scope for v1**
- Custom TTS or audio output
- Voice input
- Multi-file selection
- File preview
- Network / cloud storage locations
- Settings UI

---

## Implementation Notes & Open Questions

### Critical Architecture Shift
The current prototype in `src/main.rs` uses `egui`. **This must be migrated to the Tauri + HTML stack** defined in this README. `egui` renders to a canvas and is fundamentally incompatible with screen readers like JAWS/NVDA.

### Open Questions for the Team
1. **Symlink Handling:** Should we follow symlinks or treat them as files? (v1 Recommendation: Treat as files to avoid infinite loops).
2. **Hidden Files:** Should the UI toggle hidden files? (v1 Recommendation: Respect OS defaults).
3. **IPC Overhead:** For directories with > 50,000 files, should we use a paginated IPC stream or a shared memory buffer to prevent the UI thread from locking?
4. **Search Depth:** Does the v1 search go deep into subdirectories or stay within the current scope? (v1 Recommendation: Current scope + 2 levels deep).

---

## Platform Support

| Platform | Webview | Screen readers |
|---|---|---|
| Windows 10 / 11 | WebView2 (Edge) | JAWS, NVDA |
| macOS | WKWebView (Safari) | VoiceOver |
| Linux | WebKitGTK | Orca |
