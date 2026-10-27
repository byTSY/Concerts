-- Concerts parcourus dans les cercles des mois (version 1.14.0) : un concert compte comme vu quand
-- le membre passe à la fiche suivante ; il ne réapparaît plus dans le cercle de son mois, sur aucun
-- appareil. Distinct de seen_cards (nouveautés « NEW ») : « Tout revoir » ne touche pas aux
-- nouveautés. month (AAAA-MM) : mois du concert au moment du passage, pour « Tout revoir ».
-- Lignes de plus de 400 jours effacées à l'écriture (concerts passés).
-- Retour arrière : DROP TABLE month_seen; DELETE FROM schema_migrations WHERE name = '0014_month_seen.sql';
CREATE TABLE IF NOT EXISTS month_seen (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concert_id TEXT NOT NULL,
  month      TEXT NOT NULL,
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, concert_id)
);
CREATE INDEX IF NOT EXISTS month_seen_user_month ON month_seen (user_id, month);
