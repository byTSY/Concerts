-- Version 1.9.0 : notifications par e-mail, signalements « J'ai un problème », nouvel essai
-- automatique après une erreur passagère (quota Spotify), Spotify préparé dès l'invitation.
--
-- invitations.spotify_account_* : compte Spotify saisi par l'admin à la création du lien (il l'a
--   ajouté chez Spotify) ; à l'inscription, la source Spotify est créée prête à être connectée.
-- music_sources.retry_at / retry_count : nouvel essai automatique du calcul après une erreur
--   passagère (quota, Spotify ou Deezer indisponible, erreur interne), espacé, 4 au plus.
-- music_sources.library_read_at : dernière lecture réussie de la bibliothèque Spotify (un
--   traitement complet relancé dans la journée réutilise la lecture récente).
-- service_pauses : service extérieur en pause jusqu'à une heure donnée (Spotify, quota).
-- notifications : e-mails à envoyer (file d'attente, envoyés par GitHub Actions).
-- problem_reports : signalements des membres, visibles dans l'onglet Admin.
--
-- Retour arrière : DROP TABLE problem_reports; DROP TABLE notifications; DROP TABLE service_pauses;
--                  ALTER TABLE music_sources DROP COLUMN library_read_at;
--                  ALTER TABLE music_sources DROP COLUMN retry_count;
--                  ALTER TABLE music_sources DROP COLUMN retry_at;
--                  ALTER TABLE invitations DROP COLUMN spotify_account_name;
--                  ALTER TABLE invitations DROP COLUMN spotify_account_email;
--                  DELETE FROM schema_migrations WHERE name = '0011_notifications.sql';
ALTER TABLE invitations ADD COLUMN spotify_account_email TEXT;
ALTER TABLE invitations ADD COLUMN spotify_account_name TEXT;
ALTER TABLE music_sources ADD COLUMN retry_at TEXT;
ALTER TABLE music_sources ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE music_sources ADD COLUMN library_read_at TEXT;

CREATE TABLE IF NOT EXISTS service_pauses (
  service    TEXT PRIMARY KEY,          -- « spotify »
  until      TEXT NOT NULL,             -- pas d'appel avant cette heure (UTC, ISO)
  reason     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,             -- member_joined, member_login, problem_report, results_ready…
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  to_admin   INTEGER NOT NULL DEFAULT 0, -- 1 : à l'admin ; 0 : au membre user_id
  payload    TEXT,                       -- JSON : détails du message (jamais de jeton)
  dedupe_key TEXT UNIQUE,                -- un seul message par clé (connexion du jour, erreur…)
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS notifications_unsent ON notifications (sent_at, created_at);

CREATE TABLE IF NOT EXISTS problem_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     TEXT,
  context     TEXT,                      -- JSON : écran, statut, source, version, navigateur
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS problem_reports_user ON problem_reports (user_id, created_at);

-- Membres restés en erreur passagère avant la version 1.9.0 (quota Spotify du 13 octobre 2026) :
-- nouvel essai automatique dès la prochaine relance (2 heures au plus) ou ouverture du site
UPDATE music_sources SET retry_at = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
WHERE status = 'connected' AND last_sync_status IN ('quota', 'spotify_unavailable', 'deezer_unavailable', 'internal');
