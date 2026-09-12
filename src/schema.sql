CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  configured_identity TEXT NOT NULL,
  profile_ref TEXT,
  authenticated_identity TEXT,
  status TEXT NOT NULL DEFAULT 'unverified',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connector_id, configured_identity)
) STRICT;

CREATE TABLE IF NOT EXISTS account_capture_kinds (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('like', 'save', 'repost', 'manual')),
  PRIMARY KEY(account_id, kind)
) STRICT;

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  external_id TEXT NOT NULL,
  canonical_url TEXT,
  author_handle TEXT,
  author_name TEXT,
  text TEXT,
  evidence_text TEXT NOT NULL DEFAULT '',
  source_created_at TEXT,
  first_collected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  availability TEXT NOT NULL DEFAULT 'available',
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(connector_id, external_id)
) STRICT;

CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  kind TEXT NOT NULL CHECK(kind IN ('like', 'save', 'repost', 'manual')),
  native_kind TEXT NOT NULL,
  captured_at TEXT,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  UNIQUE(account_id, source_id, kind)
) STRICT;

CREATE TABLE IF NOT EXISTS objects (
  sha256 TEXT PRIMARY KEY,
  byte_size INTEGER NOT NULL,
  mime_type TEXT,
  object_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  object_sha256 TEXT REFERENCES objects(sha256),
  source_url TEXT,
  original_filename TEXT,
  mime_type TEXT,
  parent_evidence_id INTEGER REFERENCES evidence(id),
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_id, dedupe_key)
) STRICT;

CREATE TABLE IF NOT EXISTS collection_runs (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('like', 'save', 'repost', 'manual')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS manual_sync_receipts (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('like', 'save', 'repost', 'manual')),
  connector_id TEXT NOT NULL,
  authenticated_identity TEXT NOT NULL,
  success_at TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES collection_runs(id),
  PRIMARY KEY(account_id, kind)
) STRICT;

CREATE TABLE IF NOT EXISTS sync_cursors (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('like', 'save', 'repost', 'manual')),
  cursor TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, kind)
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
  text,
  author_handle,
  author_name,
  canonical_url,
  evidence_text,
  content='sources',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS sources_ai AFTER INSERT ON sources BEGIN
  INSERT INTO sources_fts(rowid, text, author_handle, author_name, canonical_url, evidence_text)
  VALUES (new.id, new.text, new.author_handle, new.author_name, new.canonical_url, new.evidence_text);
END;

CREATE TRIGGER IF NOT EXISTS sources_ad AFTER DELETE ON sources BEGIN
  INSERT INTO sources_fts(sources_fts, rowid, text, author_handle, author_name, canonical_url, evidence_text)
  VALUES ('delete', old.id, old.text, old.author_handle, old.author_name, old.canonical_url, old.evidence_text);
END;

CREATE TRIGGER IF NOT EXISTS sources_au AFTER UPDATE ON sources BEGIN
  INSERT INTO sources_fts(sources_fts, rowid, text, author_handle, author_name, canonical_url, evidence_text)
  VALUES ('delete', old.id, old.text, old.author_handle, old.author_name, old.canonical_url, old.evidence_text);
  INSERT INTO sources_fts(rowid, text, author_handle, author_name, canonical_url, evidence_text)
  VALUES (new.id, new.text, new.author_handle, new.author_name, new.canonical_url, new.evidence_text);
END;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
