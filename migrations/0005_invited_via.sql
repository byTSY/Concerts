-- Mode d'invitation (« email » par l'admin, « link » par lien personnel, adresse saisie par la
-- personne) et ajout à la liste Access en attente (échec de l'API Cloudflare), montrés à l'admin.
ALTER TABLE users ADD COLUMN invited_via TEXT;
ALTER TABLE users ADD COLUMN access_pending INTEGER NOT NULL DEFAULT 0;
