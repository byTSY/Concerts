-- Vérification automatique des salles proposées (version 1.12.0) : à chaque proposition avec
-- page programme, la tâche venue-check lit la page et contrôle le résultat. Réussite : la salle
-- entre au catalogue (auto_approved = 1) ; échec : elle reste en attente, avec les raisons.
-- check_status : running (vérification demandée), ok, failed ; NULL : jamais vérifiée.
-- check_summary : JSON { method, url, reasons, stats, sample } (Admin, e-mail à l'admin).
-- checked_at : dernière demande ou dernier résultat.
-- Retour arrière : ALTER TABLE venues DROP COLUMN check_status; ALTER TABLE venues DROP COLUMN check_summary; ALTER TABLE venues DROP COLUMN checked_at; ALTER TABLE venues DROP COLUMN auto_approved; DELETE FROM schema_migrations WHERE name = '0012_venue_check.sql';
ALTER TABLE venues ADD COLUMN check_status TEXT CHECK (check_status IN ('running', 'ok', 'failed'));
ALTER TABLE venues ADD COLUMN check_summary TEXT;
ALTER TABLE venues ADD COLUMN checked_at TEXT;
ALTER TABLE venues ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0;
