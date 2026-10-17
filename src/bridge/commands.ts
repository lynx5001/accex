/**
 * Typed wrappers around the Tauri commands defined in `src-tauri/src/lib.rs`.
 * The rest of the frontend never calls `invoke` directly.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  Bookmark,
  DirectoryListing,
  FsChange,
  Operation,
  OperationOutcome,
  ResolvedLocation,
  SearchResults,
} from "./types";

export const FS_CHANGE_EVENT = "fs-change";

export function initialLocation(): Promise<string> {
  return invoke("initial_location");
}

export function readDirectory(path: string, showHidden = false): Promise<DirectoryListing> {
  return invoke("read_directory", { path, showHidden });
}

export function fallbackDirectory(path: string): Promise<string> {
  return invoke("fallback_directory", { path });
}

export function resolveLocation(input: string): Promise<ResolvedLocation> {
  return invoke("resolve_location", { input });
}

export function searchFiles(
  scope: string,
  query: string,
  limit: number,
  showHidden = false,
): Promise<SearchResults> {
  return invoke("search_files", { scope, query, limit, showHidden });
}

export function executeOperation(operation: Operation, path: string): Promise<OperationOutcome> {
  return invoke("execute_operation", { operation, path });
}

export function listBookmarks(): Promise<Bookmark[]> {
  return invoke("list_bookmarks");
}

export function removeBookmark(path: string): Promise<boolean> {
  return invoke("remove_bookmark", { path });
}

export function onFsChange(handler: (change: FsChange) => void): Promise<UnlistenFn> {
  return listen<FsChange>(FS_CHANGE_EVENT, (event) => handler(event.payload));
}
