-- Liens d'invitation (invitation sans connaître l'adresse e-mail) : l'admin crée un lien
-- personnel pour un prénom ; la personne y saisit son adresse, qui est alors inscrite. Seule
-- l'empreinte SHA-256 du jeton est gardée. La ligne est effacée dès que le lien sert.
CREATE TABLE IF NOT EXISTS invitations (
  id         TEXT PRIMARY KEY,                        -- i_ + 8 caractères aléatoires
  token_hash TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
