-- Metadata cache of previously visited directories. Used by search to find
-- matches deeper than the flat-walk depth limit. Not used for configuration.
CREATE TABLE IF NOT EXISTS entries (
    path        TEXT PRIMARY KEY NOT NULL,
    parent      TEXT NOT NULL,
    name        TEXT NOT NULL,
    name_lower  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    size        INTEGER,
    modified    INTEGER,
    extension   TEXT,
    hidden      INTEGER NOT NULL DEFAULT 0,
    indexed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent);
CREATE INDEX IF NOT EXISTS idx_entries_name_lower ON entries(name_lower);
