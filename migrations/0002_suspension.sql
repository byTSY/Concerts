-- Réactivation d'un membre suspendu : retour au statut qu'il avait avant la suspension
-- (spécification, section 9.3).
ALTER TABLE users ADD COLUMN status_before_suspension TEXT;
