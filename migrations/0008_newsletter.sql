-- Newsletter du lundi (version 1.5.0) : envoyée par défaut, désabonnement dans « Mon compte » ou
-- par le lien de l'e-mail (jeton personnel, page publique /partage/desabonnement/<jeton>).
-- newsletter_sent_at : date du dernier envoi, pour ne jamais envoyer deux fois le même jour.
-- Retour arrière : DROP INDEX users_newsletter_token;
--                  ALTER TABLE users DROP COLUMN newsletter_sent_at;
--                  ALTER TABLE users DROP COLUMN newsletter_token;
--                  ALTER TABLE users DROP COLUMN newsletter;
--                  DELETE FROM schema_migrations WHERE name = '0008_newsletter.sql';
ALTER TABLE users ADD COLUMN newsletter INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN newsletter_token TEXT;
ALTER TABLE users ADD COLUMN newsletter_sent_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_newsletter_token ON users (newsletter_token);
