/**
 * English strings (the fallback locale). Every user-facing string, including
 * ARIA labels, lives here. `{name}` placeholders are filled by `t()`.
 */
export const en = {
  "app.title": "Accessible File Explorer",
  "location.label": "Current location",
  "location.announce": "Current location: {path}",
  "location.separator": " / ",
  "location.root": "Root",
  "location.edit": "Type a location",
  "location.home": "Home",
  "location.search": "Search",

  "columns.name": "Name",
  "columns.size": "Size",
  "columns.modified": "Modified",
  "date.today": "Today {time}",

  "tree.label": "Contents of {name}",
  "tree.searchLabel": "Search results for {query}",
  "tree.loading": "Loading…",
  "tree.empty": "This folder is empty",
  "tree.noResults": "No results",
  "tree.moreResults": "Show more results ({shown} of {total})",
  "tree.moreResultsUnknown": "Show more results ({shown} shown)",

  "kind.directory": "Folder",
  "kind.symlink": "Shortcut",
  "kind.file": "File",
  "kind.fileWithExt": "{ext} file",
  "meta.modified": "modified {date}",
  "meta.in": "in {path}",

  "nav.opened": "{name}, {count} items",
  "nav.openedEmpty": "{name}, empty",
  "nav.atRoot": "Already at the top level",
  "nav.fallback": "Location no longer available. Moved to {name}.",

  "search.dialogLabel": "Search",
  "search.inputLabel": "Search in {name}. Press Enter to search, Escape to cancel.",
  "search.placeholder": "Name, type or path…",
  "search.searching": "Searching…",
  "search.results": "{count} results",
  "search.resultsOne": "1 result",
  "search.resultsTruncated": "Showing {shown} of {total} results",
  "search.noResults": "No results for {query}",
  "search.closed": "Search results closed",

  "palette.dialogLabel": "Commands",
  "palette.inputLabel": "Command for {name}. Type to filter, arrow down for suggestions.",
  "palette.inputLabelNoTarget": "Command. Type to filter, arrow down for suggestions.",
  "palette.listLabel": "Commands",
  "palette.noMatch": "No matching command",
  "palette.renameLabel": "New name for {name}. Press Enter to rename, Escape to cancel.",
  "palette.suggestions": "{count} suggestions",
  "op.open": "Open",
  "op.copy": "Copy",
  "op.cut": "Cut",
  "op.paste": "Paste",
  "op.delete": "Delete",
  "op.rename": "Rename",
  "op.bookmark": "Bookmark current path",

  "outcome.opened": "Opened {name}",
  "outcome.copied": "Copied {name}",
  "outcome.cut": "Cut {name}",
  "outcome.pasted": "Pasted {name}",
  "outcome.moved": "Moved {name}",
  "outcome.deleted": "Moved {name} to the trash",
  "outcome.renamed": "Renamed to {name}",
  "outcome.bookmarked": "Bookmarked {name}",
  "outcome.alreadyBookmarked": "{name} is already bookmarked",

  "bookmarks.dialogLabel": "Bookmarks",
  "bookmarks.listLabel": "Bookmarks. Enter to open, Delete to remove, Escape to close.",
  "bookmarks.empty": "No bookmarks yet. Use the command menu to bookmark the current folder.",
  "bookmarks.removed": "Removed bookmark {name}",

  "error.permissionDenied": "Access denied to {name}.",
  "error.notFound": "{name} was not found.",
  "error.alreadyExists": "{name} already exists.",
  "error.invalidPath": "That is not a valid location.",
  "error.invalidName": "That name is not allowed.",
  "error.notADirectory": "{name} is not a folder.",
  "error.refused": "This operation is not allowed here.",
  "error.clipboardEmpty": "Nothing to paste. Copy or cut an item first.",
  "error.io": "The operation failed: {message}",
  "error.index": "Search index problem: {message}",
  "error.unknown": "Something went wrong.",
};

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
