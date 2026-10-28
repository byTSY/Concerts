-- Lien d'invité (version 1.15.0) : l'admin copie depuis l'Admin un lien /visite/<jeton>/ qui
-- montre l'application en lecture seule, sur ses artistes, ses concerts et ses salles favorites,
-- sans connexion. Un seul lien par admin ; « Nouveau lien » remplace l'ancien, qui cesse de
-- marcher. Le jeton est gardé tel quel pour pouvoir être recopié depuis l'Admin : il ne donne
-- accès qu'à cette vue, jamais aux ★, retraits, adresse e-mail ni à une écriture.
-- Retour arrière : DROP TABLE guest_links; DELETE FROM schema_migrations WHERE name = '0015_guest_link.sql';
CREATE TABLE IF NOT EXISTS guest_links (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
