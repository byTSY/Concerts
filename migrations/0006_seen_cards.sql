-- Fiches Reels déjà vues par chaque membre (version 1.2.0) : une fiche vue ne réapparaît sur
-- aucun appareil. Lignes de plus de 400 jours effacées à l'écriture (concerts passés).
-- Retour arrière : DROP TABLE seen_cards; DELETE FROM schema_migrations WHERE name = '0006_seen_cards.sql';
CREATE TABLE IF NOT EXISTS seen_cards (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concert_id TEXT NOT NULL,
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, concert_id)
);
