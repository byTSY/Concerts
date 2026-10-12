// Seul module qui lit ou écrit les tables personnelles de D1 et le préfixe R2 users/<id>/.
//
// Règles (spécification, section 5.3) : l'identifiant du membre vient toujours du jeton Access
// vérifié (middleware), jamais de la requête ; chaque requête SQL porte « user_id = ? » lié à
// ce membre ; les objets R2 ne sont servis que par ce module.

import { HttpError, norm, nowIso } from "./http.js";

const USER_FIELDS = "id, email, first_name, pseudo, role, status, default_visibility, error_message, " +
  "invited_at, activated_at, last_seen_at";

// Membre correspondant à l'e-mail du jeton Access, ou null
export async function identify(env, email) {
  return env.DB.prepare(`SELECT ${USER_FIELDS} FROM users WHERE email = ?`).bind(email).first();
}

const STAR_STATUS = new Set(["interested", "going"]);
const VISIBILITY = new Set(["private", "members"]);
const CONCERT_ID = /^[a-z0-9]{6,40}$/;

export function member(env, user) {
  const id = user.id;
  const db = env.DB;
  const key = (name) => `users/${id}/${name}.json`;

  async function object(name) {
    const obj = await env.BUCKET.get(key(name));
    return obj;
  }

  const api = {
    user,

    // Connexion (nouvelle valeur iat du jeton), dernière visite et compteurs d'activité du jour
    async touch({ iat, write }) {
      const now = nowIso();
      const day = now.slice(0, 10);
      const statements = [
        db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now, id),
        db.prepare("INSERT INTO activity_daily (user_id, day, api_calls, changes) VALUES (?, ?, 1, ?) " +
          "ON CONFLICT (user_id, day) DO UPDATE SET api_calls = api_calls + 1, changes = changes + excluded.changes")
          .bind(id, day, write ? 1 : 0),
      ];
      if (iat) {
        const started = new Date(iat * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
        statements.push(db.prepare("INSERT OR IGNORE INTO connections (user_id, session_started_at) VALUES (?, ?)")
          .bind(id, started));
      }
      // Première connexion d'un membre invité : il passe à l'accueil (choix de la source)
      if (user.status === "invited") {
        statements.push(db.prepare("UPDATE users SET status = 'onboarding' WHERE id = ? AND status = 'invited'").bind(id));
      }
      await db.batch(statements);
    },

    async profile() {
      const source = await db.prepare(
        "SELECT provider, provider_name, status, connected_at, last_sync_at, last_sync_status, sync_requested_at " +
        "FROM music_sources WHERE user_id = ?").bind(id).first();
      const favorites = await db.prepare("SELECT venue_id FROM venue_favorites WHERE user_id = ? ORDER BY added_at")
        .bind(id).all();
      return {
        display_name: user.pseudo || user.first_name,
        first_name: user.first_name,
        pseudo: user.pseudo,
        email: user.email,
        role: user.role,
        status: user.status,
        default_visibility: user.default_visibility,
        source: source || null,
        favorite_venues: favorites.results.map((r) => r.venue_id),
      };
    },

    // Fichiers calculés (R2) : renvoyés tels quels, sans les relire (limite de temps de calcul)
    artistsObject: () => object("artists"),

    async concertsBody() {
      const [overlay, meta] = await Promise.all([object("overlay"), object("meta")]);
      const [o, m] = await Promise.all([overlay ? overlay.text() : "{}", meta ? meta.text() : "null"]);
      return `{"overlay":${o},"meta":${m}}`;
    },

    // Préférences : { hidden: [noms], levels: { nom: niveau } }
    async prefs() {
      const { results } = await db.prepare(
        "SELECT artist_name, hidden, level FROM artist_prefs WHERE user_id = ? ORDER BY artist_key").bind(id).all();
      return {
        hidden: results.filter((r) => r.hidden).map((r) => r.artist_name),
        levels: Object.fromEntries(results.filter((r) => r.level).map((r) => [r.artist_name, r.level])),
      };
    },

    async setArtistPref(artistKey, { name, hidden, level }) {
      if (!artistKey || norm(artistKey) !== artistKey) throw new HttpError(400, "clé d'artiste invalide");
      if (name !== undefined && norm(name) !== artistKey) throw new HttpError(400, "le nom ne correspond pas à la clé");
      if (hidden !== undefined && typeof hidden !== "boolean") throw new HttpError(400, "hidden : vrai ou faux");
      if (level !== undefined && level !== null && ![1, 2, 3].includes(level)) throw new HttpError(400, "niveau : 1, 2, 3 ou null");
      const current = await db.prepare(
        "SELECT artist_name, hidden, level FROM artist_prefs WHERE user_id = ? AND artist_key = ?").bind(id, artistKey).first();
      const next = {
        // La graphie déjà enregistrée est gardée
        name: current?.artist_name || String(name || artistKey).trim().slice(0, 200),
        hidden: hidden === undefined ? Boolean(current?.hidden) : hidden,
        level: level === undefined ? (current?.level ?? null) : level,
      };
      if (!next.hidden && !next.level) {
        await db.prepare("DELETE FROM artist_prefs WHERE user_id = ? AND artist_key = ?").bind(id, artistKey).run();
      } else {
        await db.prepare(
          "INSERT INTO artist_prefs (user_id, artist_key, artist_name, hidden, level, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (user_id, artist_key) DO UPDATE SET hidden = excluded.hidden, level = excluded.level, " +
          "updated_at = excluded.updated_at")
          .bind(id, artistKey, next.name, next.hidden ? 1 : 0, next.level, nowIso()).run();
      }
      return api.prefs();
    },

    async stars() {
      const { results } = await db.prepare(
        "SELECT concert_id, label, status, visibility, created_at, updated_at FROM stars WHERE user_id = ? ORDER BY created_at")
        .bind(id).all();
      return results;
    },

    async setStar(concertId, { label, status, visibility }) {
      if (!CONCERT_ID.test(concertId)) throw new HttpError(400, "identifiant de concert invalide");
      if (status !== undefined && !STAR_STATUS.has(status)) throw new HttpError(400, "statut : interested ou going");
      if (visibility !== undefined && !VISIBILITY.has(visibility)) throw new HttpError(400, "visibilité : private ou members");
      const now = nowIso();
      const current = await db.prepare(
        "SELECT label, status, visibility FROM stars WHERE user_id = ? AND concert_id = ?").bind(id, concertId).first();
      await db.prepare(
        "INSERT INTO stars (user_id, concert_id, label, status, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (user_id, concert_id) DO UPDATE SET label = excluded.label, status = excluded.status, " +
        "visibility = excluded.visibility, updated_at = excluded.updated_at")
        .bind(id, concertId,
          label === undefined ? (current?.label ?? "") : String(label).replace(/\s+/g, " ").trim().slice(0, 200),
          status ?? current?.status ?? "interested",
          visibility ?? current?.visibility ?? user.default_visibility ?? "private",
          now, now).run();
      return api.stars();
    },

    async deleteStar(concertId) {
      if (!CONCERT_ID.test(concertId)) throw new HttpError(400, "identifiant de concert invalide");
      await db.prepare("DELETE FROM stars WHERE user_id = ? AND concert_id = ?").bind(id, concertId).run();
      return api.stars();
    },

    // Salles favorites : seulement des salles approuvées du catalogue commun
    async setFavoriteVenue(venueId, on) {
      if (on) {
        const venue = await db.prepare("SELECT id FROM venues WHERE id = ? AND status = 'approved' AND excluded = 0")
          .bind(venueId).first();
        if (!venue) throw new HttpError(404, "salle absente du catalogue");
        await db.prepare("INSERT OR IGNORE INTO venue_favorites (user_id, venue_id, added_at) VALUES (?, ?, ?)")
          .bind(id, venueId, nowIso()).run();
      } else {
        await db.prepare("DELETE FROM venue_favorites WHERE user_id = ? AND venue_id = ?").bind(id, venueId).run();
      }
      const { results } = await db.prepare("SELECT venue_id FROM venue_favorites WHERE user_id = ? ORDER BY added_at")
        .bind(id).all();
      return results.map((r) => r.venue_id);
    },
  };
  return api;
}
