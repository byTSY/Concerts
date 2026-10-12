-- Schéma initial de la base D1 (membres, sources, préférences, salles, ★, traitements).
-- Appliqué par « python -m src.migrate schema » (API REST D1, ou base SQLite locale).

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,                -- u_ + 8 caractères aléatoires
  email              TEXT NOT NULL UNIQUE,            -- en minuscules
  first_name         TEXT NOT NULL,
  pseudo             TEXT UNIQUE COLLATE NOCASE,
  role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status             TEXT NOT NULL DEFAULT 'invited'
                     CHECK (status IN ('invited', 'onboarding', 'computing', 'active', 'error', 'suspended')),
  default_visibility TEXT NOT NULL DEFAULT 'private' CHECK (default_visibility IN ('private', 'members')),
  error_message      TEXT,
  invited_at         TEXT NOT NULL,
  activated_at       TEXT,
  suspended_at       TEXT,
  last_seen_at       TEXT
);

CREATE TABLE IF NOT EXISTS music_sources (
  user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL CHECK (provider IN ('deezer', 'spotify')),
  provider_user_id      TEXT,
  provider_name         TEXT,
  status                TEXT NOT NULL
                        CHECK (status IN ('pending_allowlist', 'ready_to_connect', 'connected', 'error', 'revoked')),
  spotify_account_email TEXT,
  spotify_account_name  TEXT,
  refresh_token_enc     TEXT,
  scopes                TEXT,
  connected_at          TEXT,
  last_sync_at          TEXT,
  last_sync_status      TEXT,
  sync_requested_at     TEXT,
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_started_at TEXT NOT NULL,                   -- valeur iat du jeton Access
  PRIMARY KEY (user_id, session_started_at)
);

CREATE TABLE IF NOT EXISTS activity_daily (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day       TEXT NOT NULL,
  api_calls INTEGER NOT NULL DEFAULT 0,
  changes   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS artist_prefs (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_key  TEXT NOT NULL,                          -- nom normalisé (util.norm)
  artist_name TEXT NOT NULL,
  hidden      INTEGER NOT NULL DEFAULT 0,
  level       INTEGER CHECK (level IN (1, 2, 3)),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, artist_key)
);

-- Catalogue commun des salles
CREATE TABLE IF NOT EXISTS venues (
  id          TEXT PRIMARY KEY,                       -- nom normalisé, sans article
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',             -- JSON
  agenda_url  TEXT,
  excluded    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  proposed_at TEXT,
  reviewed_at TEXT,
  review_note TEXT
);

CREATE TABLE IF NOT EXISTS venue_favorites (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, venue_id)
);

CREATE TABLE IF NOT EXISTS stars (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concert_id TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'interested' CHECK (status IN ('interested', 'going')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'members')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, concert_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('weekly', 'member')),
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT,
  sources    TEXT                                     -- JSON
);

CREATE TABLE IF NOT EXISTS member_runs (
  run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT,
  status     TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_code TEXT,
  duration_s REAL,
  PRIMARY KEY (run_id, user_id)
);

CREATE INDEX IF NOT EXISTS stars_visibility ON stars (visibility, concert_id);
