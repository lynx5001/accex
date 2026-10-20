/**
 * TypeScript mirrors of the Rust data models in `src-tauri/src`.
 * Keep these in sync with the `#[derive(Serialize)]` structs there.
 */

/** `engine::fs::EntryKind` */
export type EntryKind = "directory" | "file" | "symlink";

/** `engine::fs::FileEntry` */
export interface FileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  /** Bytes; files only. */
  size: number | null;
  /** Milliseconds since the Unix epoch. */
  modified: number | null;
  /** Lower-case extension without the dot. */
  extension: string | null;
  hidden: boolean;
}

/** `engine::fs::PathSegment` */
export interface PathSegment {
  name: string;
  path: string;
}

/** `lib::DirectoryListing` */
export interface DirectoryListing {
  path: string;
  name: string;
  parent: string | null;
  breadcrumbs: PathSegment[];
  entries: FileEntry[];
}

/** `lib::ResolvedLocation` */
export interface ResolvedLocation {
  path: string;
  isDirectory: boolean;
}

/** `engine::search::SearchHit` (entry fields are flattened). */
export interface SearchHit extends FileEntry {
  parent: string;
}

/** `engine::search::SearchResults` */
export interface SearchResults {
  hits: SearchHit[];
  total: number;
  truncated: boolean;
}

/** `engine::bookmarks::Bookmark` */
export interface Bookmark {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** `state::ClipboardMode` */
export type ClipboardMode = "copy" | "cut";

/** `lib::Operation` */
export type Operation =
  | { type: "open" }
  | { type: "copy" }
  | { type: "cut" }
  | { type: "paste" }
  | { type: "delete" }
  | { type: "rename"; newName: string }
  | { type: "bookmark" };

export type OperationType = Operation["type"];

/** `lib::OperationOutcome` */
export type OperationOutcome =
  | { type: "opened"; name: string }
  | { type: "navigate"; path: string }
  | { type: "clipboard"; mode: ClipboardMode; name: string }
  | { type: "pasted"; mode: ClipboardMode; path: string; name: string }
  | { type: "deleted"; name: string }
  | { type: "renamed"; path: string; name: string }
  | { type: "bookmarked"; name: string; added: boolean };

/** `error::AppError` as serialized across the bridge. */
export interface AppError {
  kind:
    | "permissionDenied"
    | "notFound"
    | "alreadyExists"
    | "invalidPath"
    | "invalidName"
    | "notADirectory"
    | "refused"
    | "clipboardEmpty"
    | "io"
    | "index";
  path: string | null;
  message: string;
}

/** `engine::watcher::ChangeKind` */
export type ChangeKind = "created" | "removed" | "renamed" | "modified" | "rescan";

/** `engine::watcher::FsChange`, payload of the `fs-change` event. */
export interface FsChange {
  directory: string;
  kind: ChangeKind;
  paths: string[];
}

/** Type guard for errors returned by `invoke`. */
export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppError).kind === "string" &&
    typeof (value as AppError).message === "string"
  );
}
