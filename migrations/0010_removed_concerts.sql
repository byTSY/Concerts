-- Concerts retirés par chaque membre (version 1.8.0) : « Ne plus voir ce concert » (fiche, Reels,
-- geste vers le bas). Le concert sort du calendrier, des listes, des Reels et de la newsletter du
-- membre, sans toucher à l'artiste. Il reste dans « Concerts retirés » jusqu'à sa date, avec
-- « Remettre ». Libellé, date, salle, titre et liens gardés pour le reconnaître si son identifiant
-- change d'une semaine à l'autre. Lignes passées effacées à l'écriture.
-- Retour arrière : DROP TABLE removed_concerts; DELETE FROM schema_migrations WHERE name = '0010_removed_concerts.sql';
CREATE TABLE IF NOT EXISTS removed_concerts (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concert_id   TEXT NOT NULL,
  concert_date TEXT NOT NULL,
  label        TEXT NOT NULL,
  venue        TEXT,
  title        TEXT,
  urls         TEXT,
  removed_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, concert_id)
);
