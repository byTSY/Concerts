-- ★ visibles par les autres membres par défaut (version 1.7.0) : chaque membre peut choisir
-- « masqués » dans « Mon compte », et masquer un concert précis sur sa fiche. Les nouveaux membres
-- reçoivent « members » à leur création (functions/_lib/me.js) ; les membres existants passent à
-- « members ». Les ★ déjà posés gardent leur visibilité.
-- Retour arrière (remet aussi « masqués » les membres qui avaient choisi « visibles » avant 1.7.0) :
--                  UPDATE users SET default_visibility = 'private';
--                  DELETE FROM schema_migrations WHERE name = '0009_visible_by_default.sql';
UPDATE users SET default_visibility = 'members';
