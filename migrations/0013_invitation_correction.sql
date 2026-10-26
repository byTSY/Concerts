-- Inscription simplifiée (version 1.13.0) : un lien d'invitation utilisé n'est plus effacé tout
-- de suite. Il reste 24 heures, rattaché au nouveau membre (claimed_by), pour corriger une adresse
-- mal saisie tant que le membre ne s'est pas encore connecté. Il ne peut plus créer de membre.
-- claim_secret_hash : empreinte du secret déposé (cookie) dans le navigateur qui a fait
--   l'inscription ; seul ce navigateur peut voir et corriger l'adresse.
-- corrections : nombre de corrections faites (3 au plus).
-- Lignes utilisées et expirées : effacées à la lecture de la liste des liens (Admin).
-- Retour arrière : ALTER TABLE invitations DROP COLUMN corrections; ALTER TABLE invitations DROP COLUMN claim_secret_hash; ALTER TABLE invitations DROP COLUMN claimed_by; DELETE FROM schema_migrations WHERE name = '0013_invitation_correction.sql';
ALTER TABLE invitations ADD COLUMN claimed_by TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE invitations ADD COLUMN claim_secret_hash TEXT;
ALTER TABLE invitations ADD COLUMN corrections INTEGER NOT NULL DEFAULT 0;
