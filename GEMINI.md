# Accex - Gemini Memory

## Critical Architecture Alert
*   **NO EGUI:** The existing `main.rs` uses `egui`. This is deprecated for this project.
*   **STACK:** Use Tauri v2 + Rust (Backend) + Semantic HTML/TypeScript (Frontend).
*   **REASON:** Screen readers (NVDA/VoiceOver) cannot read GPU-rendered canvases.

## Build & Dev Commands
*   **Dev:** `npm run tauri dev`
*   **Build:** `npm run tauri build`
*   **Lint:** `cargo clippy` && `npm run lint`
*   **Format:** `cargo fmt`

## Coding Standards
*   **Approach:** Top-Down Decomposition. Define interfaces first, then vertical slices.
*   **Accessibility:** ARIA roles are the primary focus. All logic must support `role="tree"`.
*   **I18n:** No hardcoded strings in the UI. Use a translation keys.
*   **Errors:** Use `aria-live="polite"` for non-blocking feedback and `assertive` for critical errors.

## Technical Constraints
*   **Performance:** Directory reads < 5,000 items must render in < 100ms.
*   **Security:** Path traversal prevention is mandatory on all Rust commands.
*   **FS Watcher:** Use the `notify` crate to push updates to the UI via Tauri events.

## Memory Hierarchy
1.  `GEMINI.md` (This file - Highest Priority)
2.  `.gemini/rules/*.md` (Specific technical rules)
3.  `README.md` (Project overview and scope)

## Lessons Learned / Rules from Mistakes
*   **Mistake:** Initially assumed the project used the existing `egui` codebase found in `src/main.rs`.
*   **Rule:** Ignore all `egui` code in `src/main.rs`. The project is a full rewrite using Tauri + HTML/ARIA. Always check for the presence of a webview frontend before suggesting GUI changes.
*   **Rule:** When asked to "code," ensure the project structure is first migrated from a single-file Rust binary to a standard Tauri project layout.

## Definition of Done
*   Verified with keyboard-only navigation.
*   Semantic HTML passes `axe-core` audits.
*   Rust code is `clippy` clean.