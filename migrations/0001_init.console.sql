CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('client','admin')), client_id TEXT, password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, created_by TEXT NOT NULL, CHECK ((role = 'admin' AND client_id IS NULL) OR (role = 'client' AND client_id IS NOT NULL)));

CREATE TABLE IF NOT EXISTS auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, username TEXT, event TEXT NOT NULL, ip TEXT, user_agent TEXT, detail TEXT);

CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events (at);

CREATE TABLE IF NOT EXISTS view_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, username TEXT NOT NULL, client_id TEXT NOT NULL, path TEXT NOT NULL, day TEXT);

CREATE INDEX IF NOT EXISTS idx_view_events_at ON view_events (at);
