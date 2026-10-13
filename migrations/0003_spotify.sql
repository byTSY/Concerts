-- Spotify (spécification, étape 4) : suivi des places de l'application Spotify en mode
-- développement (5 utilisateurs ajoutés à la main par l'admin dans le tableau de bord Spotify).

-- Demande de place, confirmation de l'ajout par l'admin, refus de Spotify au retour (compte
-- encore inconnu de Spotify : e-mail à vérifier)
ALTER TABLE music_sources ADD COLUMN spotify_requested_at TEXT;
ALTER TABLE music_sources ADD COLUMN spotify_allowlisted_at TEXT;
ALTER TABLE music_sources ADD COLUMN spotify_refused_at TEXT;

-- Comptes à retirer du tableau de bord Spotify (après suppression d'un membre ou changement de
-- source) : sans lien avec users, pour survivre à la suppression du membre. La ligne est
-- effacée dès que l'admin confirme le retrait (bouton « Retiré »), ce qui libère la place.
CREATE TABLE IF NOT EXISTS spotify_removals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_name  TEXT,
  account_email TEXT NOT NULL,
  member_name   TEXT,                                   -- nom affiché du membre à la date du retrait
  reason        TEXT NOT NULL CHECK (reason IN ('deleted', 'source_changed')),
  created_at    TEXT NOT NULL
);
