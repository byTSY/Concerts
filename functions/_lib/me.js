// Seul module qui lit ou écrit les tables personnelles de D1 et le préfixe R2 users/<id>/,
// pour le membre connecté (member) comme pour l'espace admin (admin).
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

    // --- Compte du membre -------------------------------------------------------------

    // Pseudo (2 à 30 caractères, unique ; vide : prénom) et visibilité par défaut des ★
    async updateProfile({ pseudo, default_visibility }) {
      if (default_visibility !== undefined && !VISIBILITY.has(default_visibility)) {
        throw new HttpError(400, "visibilité : private ou members");
      }
      let p = pseudo === undefined ? undefined : String(pseudo ?? "").replace(/\s+/g, " ").trim();
      if (p !== undefined && p !== "" && (p.length < 2 || p.length > 30)) throw new HttpError(400, "pseudo : 2 à 30 caractères");
      if (p === "") p = null;
      try {
        await db.prepare("UPDATE users SET pseudo = CASE WHEN ?1 THEN ?2 ELSE pseudo END, " +
          "default_visibility = COALESCE(?3, default_visibility) WHERE id = ?4")
          .bind(pseudo === undefined ? 0 : 1, p ?? null, default_visibility ?? null, id).run();
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, "ce pseudo est déjà pris", "pseudo_taken");
        throw e;
      }
      Object.assign(user, await db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).bind(id).first());
      return api.profile();
    },

    // Profil Deezer proposé par le membre : public, et pas déjà rattaché à un autre membre
    async checkDeezer(profileId, preview) {
      if (preview.error === "deezer_unavailable") {
        throw new HttpError(503, "Deezer ne répond pas pour l'instant : réessayez dans quelques minutes", preview.error);
      }
      if (preview.error) {
        const message = preview.error === "private_profile"
          ? "profil privé : dans les paramètres de confidentialité de Deezer, rendez votre profil public"
          : "profil Deezer introuvable : vérifiez le lien ou le n°";
        throw new HttpError(422, message, preview.error);
      }
      const taken = await db.prepare(
        "SELECT user_id FROM music_sources WHERE provider = 'deezer' AND provider_user_id = ? AND user_id <> ?")
        .bind(profileId, id).first();
      if (taken) throw new HttpError(409, "ce profil Deezer est déjà rattaché à un autre membre", "taken");
      return preview;
    },

    // Rattache le profil Deezer et demande le calcul (statut computing)
    async connectDeezer(preview) {
      const current = await db.prepare("SELECT provider, provider_user_id FROM music_sources WHERE user_id = ?").bind(id).first();
      if (current && current.provider_user_id !== preview.id) {
        throw new HttpError(409, "détachez d'abord la source actuelle (Changer de source)", "source_attached");
      }
      // Profil déjà relié : le recalcul passe par « Synchroniser maintenant » (une fois par heure)
      if (current && user.status !== "onboarding") {
        throw new HttpError(409, "ce profil est déjà relié : utilisez « Synchroniser maintenant »", "already_connected");
      }
      const now = nowIso();
      await db.batch([
        db.prepare("INSERT INTO music_sources (user_id, provider, provider_user_id, provider_name, status, connected_at, sync_requested_at) " +
          "VALUES (?, 'deezer', ?, ?, 'connected', ?, ?) ON CONFLICT (user_id) DO UPDATE SET provider = 'deezer', " +
          "provider_user_id = excluded.provider_user_id, provider_name = excluded.provider_name, status = 'connected', " +
          "connected_at = excluded.connected_at, sync_requested_at = excluded.sync_requested_at")
          .bind(id, preview.id, preview.name || null, now, now),
        db.prepare("UPDATE users SET status = 'computing', error_message = NULL WHERE id = ? AND status <> 'suspended'").bind(id),
      ]);
      user.status = "computing";
      return api.profile();
    },

    // « Synchroniser maintenant » : une demande par heure au plus
    async requestSync() {
      const src = await db.prepare("SELECT status, sync_requested_at, last_sync_status FROM music_sources WHERE user_id = ?")
        .bind(id).first();
      if (!src || src.status !== "connected") throw new HttpError(409, "aucune source reliée", "no_source");
      if (!["active", "error"].includes(user.status)) throw new HttpError(409, "un calcul est déjà en cours", "busy");
      // Après un calcul en erreur (profil corrigé entre-temps), un nouvel essai est permis aussitôt
      const last = Date.parse(src.sync_requested_at || "");
      if (last && Date.now() - last < 3600 * 1000 && src.last_sync_status === "ok") {
        throw new HttpError(429, "une synchronisation par heure au plus : réessayez plus tard", "too_soon");
      }
      await db.prepare("UPDATE music_sources SET sync_requested_at = ? WHERE user_id = ?").bind(nowIso(), id).run();
      return api.profile();
    },

    // Détache la source (avant d'en choisir une autre) : résultats calculés et historique remis
    // à zéro ; préférences, salles et ★ conservés (spécification, section 13.2)
    async detachSource() {
      await db.batch([
        db.prepare("DELETE FROM music_sources WHERE user_id = ?").bind(id),
        db.prepare("UPDATE users SET status = 'onboarding', error_message = NULL WHERE id = ? AND status <> 'suspended'").bind(id),
      ]);
      await api.deleteFiles();
      user.status = "onboarding";
      return api.profile();
    },

    async deleteFiles() {
      const listed = await env.BUCKET.list({ prefix: `users/${id}/` });
      const keys = listed.objects.map((o) => o.key);
      if (keys.length) await env.BUCKET.delete(keys);
      return keys.length;
    },

    // Suppression complète : fichiers R2, puis le membre et toutes ses lignes (ON DELETE CASCADE ;
    // venues.proposed_by remis à null)
    async deleteAll() {
      await api.deleteFiles();
      await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      console.log(`Membre ${id} supprimé le ${nowIso()}`);
    },
  };
  return api;
}

// --- Espace admin (spécification, section 9.3) -----------------------------------------------
// Ce que voit l'admin : statut, connexions, activité, nombre de ★, état de la synchronisation.
// Jamais le contenu (artistes, concerts choisis, préférences).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newMemberId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "u_" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function admin(env) {
  const db = env.DB;
  const since = () => new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

  async function target(memberId) {
    if (!/^u_[a-z0-9]{8}$/.test(String(memberId))) throw new HttpError(400, "identifiant de membre invalide");
    const row = await db.prepare(`SELECT ${USER_FIELDS}, status_before_suspension FROM users WHERE id = ?`).bind(memberId).first();
    if (!row) throw new HttpError(404, "membre introuvable");
    return row;
  }

  return {
    target,

    async members() {
      const day = since();
      const { results } = await db.prepare(
        "SELECT u.id, u.email, u.first_name, u.pseudo, u.role, u.status, u.error_message, u.invited_at, " +
        "u.activated_at, u.suspended_at, u.last_seen_at, " +
        "s.provider, s.status AS source_status, s.last_sync_at, s.last_sync_status, s.sync_requested_at, " +
        "(SELECT COUNT(*) FROM connections c WHERE c.user_id = u.id AND c.session_started_at >= ?1) AS connections_30d, " +
        "(SELECT COALESCE(SUM(api_calls), 0) FROM activity_daily a WHERE a.user_id = u.id AND a.day >= ?1) AS api_calls_30d, " +
        "(SELECT COALESCE(SUM(changes), 0) FROM activity_daily a WHERE a.user_id = u.id AND a.day >= ?1) AS changes_30d, " +
        "(SELECT COUNT(*) FROM stars st WHERE st.user_id = u.id) AS stars " +
        "FROM users u LEFT JOIN music_sources s ON s.user_id = u.id ORDER BY u.invited_at").bind(day).all();
      return results.map((r) => ({ ...r, display_name: r.pseudo || r.first_name }));
    },

    async invite({ email, first_name }) {
      const mail = String(email || "").trim().toLowerCase();
      const name = String(first_name || "").replace(/\s+/g, " ").trim();
      if (!EMAIL.test(mail) || mail.length > 200) throw new HttpError(400, "adresse e-mail invalide");
      if (name.length < 1 || name.length > 40) throw new HttpError(400, "prénom : 1 à 40 caractères");
      const exists = await db.prepare("SELECT id FROM users WHERE email = ?").bind(mail).first();
      if (exists) throw new HttpError(409, "cette adresse est déjà inscrite", "exists");
      const memberId = newMemberId();
      await db.prepare("INSERT INTO users (id, email, first_name, role, status, invited_at) VALUES (?, ?, ?, 'member', 'invited', ?)")
        .bind(memberId, mail, name, nowIso()).run();
      return { id: memberId, email: mail, first_name: name };
    },

    async suspend(memberId) {
      const row = await target(memberId);
      if (row.role === "admin") throw new HttpError(409, "l'admin ne peut pas être suspendu");
      if (row.status === "suspended") return row;
      await db.prepare("UPDATE users SET status_before_suspension = status, status = 'suspended', suspended_at = ? WHERE id = ?")
        .bind(nowIso(), memberId).run();
      return target(memberId);
    },

    async reactivate(memberId) {
      const row = await target(memberId);
      if (row.status !== "suspended") return row;
      await db.prepare("UPDATE users SET status = COALESCE(status_before_suspension, 'onboarding'), " +
        "status_before_suspension = NULL, suspended_at = NULL WHERE id = ?").bind(memberId).run();
      return target(memberId);
    },

    async remove(memberId) {
      const row = await target(memberId);
      if (row.role === "admin") throw new HttpError(409, "l'admin ne peut pas être supprimé");
      await member(env, row).deleteAll();
      return row;
    },

    async requestRecompute(memberId) {
      const row = await target(memberId);
      const updated = await db.prepare("UPDATE music_sources SET sync_requested_at = ? WHERE user_id = ? AND status = 'connected'")
        .bind(nowIso(), memberId).run();
      if (!updated.meta?.changes) throw new HttpError(409, "ce membre n'a pas de source reliée", "no_source");
      return row;
    },

    // Traitements : dates, statuts, codes d'erreur par membre (identifiants seulement)
    async runs() {
      const { results: runs } = await db.prepare(
        "SELECT id, kind, started_at, ended_at, status, sources FROM runs ORDER BY id DESC LIMIT 20").all();
      const ids = runs.map((r) => r.id);
      const details = ids.length ? (await db.prepare(
        `SELECT run_id, user_id, provider, status, error_code, duration_s FROM member_runs WHERE run_id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids).all()).results : [];
      return runs.map((r) => ({ ...r, sources: r.sources ? JSON.parse(r.sources) : null,
        members: details.filter((d) => d.run_id === r.id) }));
    },
  };
}
