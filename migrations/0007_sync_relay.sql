-- Relais côté site (version 1.2.1) : calcul demandé depuis plus de 15 minutes sans résultat,
-- relancé à l'ouverture du site (GET /api/me), au plus une fois par 15 minutes et par membre,
-- et 3 fois au plus par demande (sync_relay_count, remis à 1 à chaque nouvelle demande).
-- Les tâches programmées de GitHub (relance des 2 heures) peuvent être retardées ou abandonnées.
-- Retour arrière : ALTER TABLE music_sources DROP COLUMN sync_relayed_at;
--                  ALTER TABLE music_sources DROP COLUMN sync_relay_count;
--                  DELETE FROM schema_migrations WHERE name = '0007_sync_relay.sql';
ALTER TABLE music_sources ADD COLUMN sync_relayed_at TEXT;
ALTER TABLE music_sources ADD COLUMN sync_relay_count INTEGER NOT NULL DEFAULT 0;
