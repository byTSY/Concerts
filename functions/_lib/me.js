// Seul module qui lit ou écrit les tables personnelles de D1 et le préfixe R2 users/<id>/,
// pour le membre connecté (member) comme pour l'espace admin (admin).
//
// Règles (spécification, section 5.3) : l'identifiant du membre vient toujours du jeton Access
// vérifié (middleware), jamais de la requête ; chaque requête SQL porte « user_id = ? » lié à
// ce membre ; les objets R2 ne sont servis que par ce module.

import { HttpError, norm, nowIso } from "./http.js";
import { tokenKeyReady } from "./tokens.js";

const USER_FIELDS = "id, email, first_name, pseudo, role, status, default_visibility, error_message, " +
  "invited_at, activated_at, last_seen_at";

// Membre correspondant à l'e-mail du jeton Access, ou null
export async function identify(env, email) {
  return env.DB.prepare(`SELECT ${USER_FIELDS} FROM users WHERE email = ?`).bind(email).first();
}

const STAR_STATUS = new Set(["interested", "going"]);
const VISIBILITY = new Set(["private", "members"]);
const CONCERT_ID = /^[a-z0-9]{6,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Catalogue des salles (spécification, sections 12 et 13.1) ---------------------------
// Identifiant d'une salle : nom normalisé sans article, mots reliés par des tirets (même règle
// que src/catalog.py, venue_id)
const normVenue = (text) => norm(text).replace(/^(le|la|les|l) /, "");
export const venueId = (name) => normVenue(name).replace(/ /g, "-");
const VENUE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PENDING_PROPOSALS = 5;

function cleanName(value, max = 80) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Mots trop courants pour désigner une salle à eux seuls : le traitement rattache un concert à
// la salle dont un nom figure dans le libellé de la salle (src/match.py, VenueMatcher)
// (mêmes mots que VENUE_STOP, src/match.py, plus quelques mots de liaison)
const GENERIC_VENUE_WORDS = new Set(["salle", "grande", "petite", "petit", "grand", "paris", "theatre", "eglise", "saint",
  "sainte", "temple", "club", "cafe", "studio", "maison", "espace", "centre", "musique", "musiques", "music",
  "auditorium", "cathedrale", "basilique", "chapelle", "conservatoire", "square", "jardin", "parc", "place", "scene",
  "live", "bar", "cave", "caveau", "jazz", "arena", "hall", "palais", "opera", "institut", "musee", "fondation",
  "philharmonie", "cite", "pavillon", "kiosque", "bibliotheque", "municipal", "municipale", "concert", "concerts",
  "de", "du", "des", "et", "a", "au", "aux", "en"]);

// Nom trop général pour désigner une salle : moins de 4 caractères, ou seulement des mots courants
const tooGeneric = (name) => {
  const key = normVenue(name);
  return key.length < 4 || key.split(" ").every((w) => GENERIC_VENUE_WORDS.has(w));
};

// Alias : liste de noms (au plus 10), sans doublon ; chacun assez distinctif (4 caractères au
// moins, pas seulement des mots courants)
function cleanAliases(value) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;\n]/);
  if (list.length > 10) throw new HttpError(400, "10 autres noms au plus");
  const out = [...new Set(list.map((a) => cleanName(a)).filter(Boolean))];
  for (const alias of out) {
    if (tooGeneric(alias)) throw new HttpError(400, `autre nom trop général : « ${alias} » (il désignerait d'autres salles)`, "generic_alias");
  }
  return out;
}

// Page programme : https, hôte public (lue par le traitement chaque semaine)
function cleanUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const invalid = () => new HttpError(400, "adresse de la page programme invalide (https://… attendu)", "bad_url");
  let url;
  try { url = new URL(text); } catch { throw invalid(); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 300 || !host.includes(".")
      || /^[\d.]+$/.test(host) || host.includes(":") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw invalid();
  }
  return url.href;
}

// Salle dont un nom contient un nom de la salle proposée, ou l'inverse (mot pour mot) : noms
// des autres salles concernées, signalés à l'admin
async function overlappingVenues(db, id, names) {
  const keys = names.map(normVenue).filter(Boolean);
  const inside = (a, b) => ` ${b} `.includes(` ${a} `);
  const { results } = await db.prepare("SELECT id, name, aliases FROM venues WHERE status = 'approved' AND id <> ?").bind(id).all();
  return results.filter((v) => [v.name, ...JSON.parse(v.aliases || "[]")].map(normVenue)
    .some((k) => keys.some((key) => inside(key, k) || inside(k, key)))).map((v) => v.name);
}

// Salle déjà connue sous ce nom ou l'un de ses autres noms : { id, status } ou null
async function knownVenue(db, name, excludeId = null) {
  const key = normVenue(name);
  const { results } = await db.prepare("SELECT id, name, aliases, status FROM venues").all();
  for (const v of results) {
    if (v.id === excludeId) continue;
    const names = [v.name, ...JSON.parse(v.aliases || "[]")].map(normVenue);
    if (v.id === venueId(name) || names.includes(key)) return v;
  }
  return null;
}

// ★ partagés (section 12) : visibilité « members », membres actifs (ni invités ni suspendus), sans ceux du
// membre qui consulte. Nom affiché et statut seulement : jamais d'identifiant de membre.
export async function communityStars(env, viewerId) {
  const { results } = await env.DB.prepare(
    "SELECT s.concert_id, COALESCE(u.pseudo, u.first_name) AS name, s.status FROM stars s JOIN users u ON u.id = s.user_id " +
    "WHERE s.visibility = 'members' AND u.status IN ('active', 'computing', 'error') AND s.user_id <> ? ORDER BY s.created_at")
    .bind(viewerId).all();
  return results;
}

// --- Places Spotify (spécification, sections 6.3 et 10) ------------------------------------
// Une place est prise par chaque source Spotify (demande en attente comprise) et par chaque
// compte encore à retirer du tableau de bord Spotify.
const SPOTIFY_USED = "(SELECT COUNT(*) FROM music_sources WHERE provider = 'spotify') + (SELECT COUNT(*) FROM spotify_removals)";
export const spotifyMax = (env) => {
  const n = Number.parseInt(env.SPOTIFY_MAX_USERS ?? "", 10);
  return Number.isInteger(n) && n >= 0 ? n : 5;
};
const spotifyEnabled = (env) => Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && tokenKeyReady(env));
// Statuts de la source qui permettent de (re)lancer l'autorisation chez Spotify
const SPOTIFY_CONNECTABLE = ["ready_to_connect", "connected", "revoked", "error"];
const OAUTH_STATE = /^[A-Za-z0-9_-]{20,100}$/;
const SOURCE_FOR_REMOVAL = "SELECT provider, spotify_account_name, spotify_account_email, spotify_allowlisted_at " +
  "FROM music_sources WHERE user_id = ?";

// null si la table des retraits manque (fonctions déployées avant la migration 0003)
async function spotifyUsed(db) {
  try {
    return (await db.prepare(`SELECT ${SPOTIFY_USED} AS used`).first()).used;
  } catch {
    return null;
  }
}

// Compte à retirer du tableau de bord Spotify, si l'admin l'y avait ajouté
function queueRemoval(db, src, memberName, reason) {
  if (!src || src.provider !== "spotify" || !src.spotify_allowlisted_at || !src.spotify_account_email) return null;
  return db.prepare("INSERT INTO spotify_removals (account_name, account_email, member_name, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(src.spotify_account_name, src.spotify_account_email, memberName, reason, nowIso());
}

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
      // Jamais refresh_token_enc ni provider_user_id dans une réponse
      const source = await db.prepare(
        "SELECT provider, provider_name, status, connected_at, last_sync_at, last_sync_status, sync_requested_at, " +
        "spotify_account_name, spotify_account_email, spotify_requested_at, spotify_refused_at " +
        "FROM music_sources WHERE user_id = ?").bind(id).first();
      const used = await spotifyUsed(db);
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
        spotify: { enabled: used !== null && spotifyEnabled(env), full: used === null || used >= spotifyMax(env) },
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

    // --- Propositions de salles (section 13.1) ------------------------------------------

    // Nouvelle salle proposée au catalogue commun, publiée après validation de l'admin
    async proposeVenue({ name, aliases, agenda_url }) {
      const clean = cleanName(name);
      const id = venueId(clean);
      if (clean.length < 2 || !VENUE_ID.test(id)) throw new HttpError(400, "nom de salle : 2 à 80 caractères", "bad_name");
      if (tooGeneric(clean)) throw new HttpError(400, "nom trop général : précisez le nom de la salle", "generic_name");
      const list = cleanAliases(aliases);
      const url = cleanUrl(agenda_url);
      for (const alias of list) {
        if (await knownVenue(db, alias)) throw new HttpError(409, `« ${alias} » désigne déjà une salle connue`, "exists");
      }
      const known = await knownVenue(db, clean);
      if (known) {
        const message = { approved: "cette salle est déjà au catalogue", pending: "cette salle est déjà proposée, en attente de l'admin",
          rejected: "cette salle a déjà été proposée et refusée" }[known.status];
        throw new HttpError(409, message, "exists");
      }
      try {
        const r = await db.prepare("INSERT INTO venues (id, name, aliases, agenda_url, excluded, status, proposed_by, proposed_at) " +
          "SELECT ?, ?, ?, ?, 0, 'pending', ?, ? WHERE (SELECT COUNT(*) FROM venues WHERE proposed_by = ? AND status = 'pending') < ?")
          .bind(id, clean, JSON.stringify(list), url, user.id, nowIso(), user.id, MAX_PENDING_PROPOSALS).run();
        if (!r.meta?.changes) {
          throw new HttpError(429, `${MAX_PENDING_PROPOSALS} propositions en attente au plus : attendez la réponse de l'admin`, "too_many");
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (/UNIQUE|PRIMARY/i.test(String(e?.message))) throw new HttpError(409, "cette salle est déjà proposée", "exists");
        throw e;
      }
      return api.venueProposals();
    },

    // Propositions du membre et réponse de l'admin
    async venueProposals() {
      const { results } = await db.prepare(
        "SELECT id, name, status, review_note, proposed_at, reviewed_at FROM venues WHERE proposed_by = ? ORDER BY proposed_at DESC")
        .bind(id).all();
      return results;
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

    // --- Spotify (spécification, sections 6.3 et 11) --------------------------------------

    // Demande de place : nom et e-mail du compte Spotify, que l'admin ajoute dans le tableau de
    // bord Spotify. Le membre peut corriger sa demande tant qu'elle est en attente.
    async requestSpotify({ account_email, account_name }) {
      const mail = String(account_email || "").trim().toLowerCase();
      const name = String(account_name || "").replace(/\s+/g, " ").trim();
      if (!EMAIL.test(mail) || mail.length > 200) throw new HttpError(400, "adresse e-mail du compte Spotify invalide", "bad_email");
      if (name.length < 2 || name.length > 80) throw new HttpError(400, "nom : 2 à 80 caractères", "bad_name");
      const current = await db.prepare(SOURCE_FOR_REMOVAL.replace("SELECT ", "SELECT status, ")).bind(id).first();
      if (current && !(current.provider === "spotify" && current.status === "pending_allowlist")) {
        throw new HttpError(409, "détachez d'abord la source actuelle (Changer de source)", "source_attached");
      }
      const taken = await db.prepare(
        "SELECT 1 FROM music_sources WHERE provider = 'spotify' AND spotify_account_email = ? AND user_id <> ?").bind(mail, id).first();
      if (taken) throw new HttpError(409, "ce compte Spotify est déjà demandé par un autre membre", "taken");
      const now = nowIso();
      // Compte encore présent chez Spotify (retrait en attente, après un changement de source) :
      // pas de retrait ni de nouvel ajout, l'accès est rouvert aussitôt
      const kept = await db.prepare("SELECT id FROM spotify_removals WHERE account_email = ? ORDER BY id LIMIT 1").bind(mail).first();
      if (kept && !current) {
        await db.batch([
          db.prepare("DELETE FROM spotify_removals WHERE id = ?").bind(kept.id),
          db.prepare("INSERT INTO music_sources (user_id, provider, status, spotify_account_email, spotify_account_name, " +
            "spotify_requested_at, spotify_allowlisted_at) VALUES (?, 'spotify', 'ready_to_connect', ?, ?, ?, ?) " +
            "ON CONFLICT (user_id) DO NOTHING").bind(id, mail, name, now, now),
        ]);
        return api.profile();
      }
      if (current) {
        // Correction de l'adresse : si l'admin avait déjà ajouté l'ancienne chez Spotify, elle est à retirer
        const changed = current.spotify_account_email !== mail;
        await db.batch([
          changed ? queueRemoval(db, current, user.pseudo || user.first_name, "source_changed") : null,
          db.prepare("UPDATE music_sources SET spotify_account_email = ?, spotify_account_name = ?, spotify_requested_at = ?, " +
            "spotify_refused_at = NULL, spotify_allowlisted_at = CASE WHEN ? THEN NULL ELSE spotify_allowlisted_at END " +
            "WHERE user_id = ? AND provider = 'spotify'").bind(mail, name, now, changed ? 1 : 0, id),
        ].filter(Boolean));
      } else {
        // Une seule instruction : deux demandes simultanées ne peuvent pas dépasser le plafond
        const r = await db.prepare(
          "INSERT INTO music_sources (user_id, provider, status, spotify_account_email, spotify_account_name, spotify_requested_at) " +
          `SELECT ?, 'spotify', 'pending_allowlist', ?, ?, ? WHERE ${SPOTIFY_USED} < ? ON CONFLICT (user_id) DO NOTHING`)
          .bind(id, mail, name, now, spotifyMax(env)).run();
        if (!r.meta?.changes) {
          const again = await db.prepare("SELECT 1 FROM music_sources WHERE user_id = ?").bind(id).first();
          if (again) return api.profile();  // demande envoyée deux fois
          throw new HttpError(409, "toutes les places Spotify sont prises : choisissez Deezer, ou parlez-en à l'admin", "spotify_full");
        }
      }
      return api.profile();
    },

    // Début de l'autorisation : state à usage unique (10 minutes) et code_verifier PKCE
    async startSpotifyAuth({ state, verifier }) {
      const src = await db.prepare("SELECT status FROM music_sources WHERE user_id = ? AND provider = 'spotify'").bind(id).first();
      if (!src || !SPOTIFY_CONNECTABLE.includes(src.status)) {
        throw new HttpError(409, "l'admin n'a pas encore ouvert votre accès Spotify", "not_ready");
      }
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await db.batch([
        db.prepare("DELETE FROM oauth_states WHERE user_id = ?").bind(id),  // une autorisation à la fois
        db.prepare("INSERT INTO oauth_states (state, user_id, code_verifier, expires_at) VALUES (?, ?, ?, ?)")
          .bind(state, id, verifier, expires),
      ]);
    },

    // Retour de Spotify : le state doit appartenir au membre connecté ; il est consommé
    async takeSpotifyState(state) {
      if (!OAUTH_STATE.test(String(state || ""))) throw new HttpError(400, "retour Spotify invalide", "bad_state");
      const row = await db.prepare("SELECT code_verifier, expires_at FROM oauth_states WHERE state = ? AND user_id = ?")
        .bind(state, id).first();
      if (!row) throw new HttpError(403, "retour Spotify refusé : autorisation commencée par un autre compte, ou déjà utilisée", "bad_state");
      const used = await db.prepare("DELETE FROM oauth_states WHERE state = ? AND user_id = ?").bind(state, id).run();
      if (!used.meta?.changes) throw new HttpError(403, "retour Spotify déjà utilisé", "bad_state");
      if (Date.parse(row.expires_at) < Date.now()) throw new HttpError(400, "autorisation expirée : recommencez", "expired");
      return row.code_verifier;
    },

    // Spotify refuse le compte (absent de User Management) : retour à la demande en attente
    async spotifyRefused() {
      await db.prepare("UPDATE music_sources SET status = 'pending_allowlist', spotify_refused_at = ?, refresh_token_enc = NULL " +
        "WHERE user_id = ? AND provider = 'spotify'").bind(nowIso(), id).run();
    },

    // Compte Spotify autorisé : jeton de rafraîchissement déjà chiffré, calcul demandé
    async connectSpotify({ spotifyId, name, tokenEnc, scopes }) {
      const src = await db.prepare("SELECT status, provider_user_id FROM music_sources WHERE user_id = ? AND provider = 'spotify'")
        .bind(id).first();
      if (!src || !SPOTIFY_CONNECTABLE.includes(src.status)) throw new HttpError(409, "source Spotify non prête", "not_ready");
      const taken = await db.prepare(
        "SELECT 1 FROM music_sources WHERE provider = 'spotify' AND provider_user_id = ? AND user_id <> ?").bind(spotifyId, id).first();
      if (taken) throw new HttpError(409, "ce compte Spotify est déjà rattaché à un autre membre", "taken");
      const now = nowIso();
      await db.batch([
        db.prepare("UPDATE music_sources SET provider_user_id = ?, provider_name = ?, status = 'connected', refresh_token_enc = ?, " +
          "scopes = ?, connected_at = ?, sync_requested_at = ?, spotify_refused_at = NULL WHERE user_id = ? AND provider = 'spotify'")
          .bind(spotifyId, name, tokenEnc, scopes, now, now, id),
        db.prepare("UPDATE users SET status = 'computing', error_message = NULL WHERE id = ? AND status <> 'suspended'").bind(id),
      ]);
      // Autre compte Spotify que la fois précédente : résultats et historique repartent de zéro
      if (src.provider_user_id && src.provider_user_id !== spotifyId) await api.deleteFiles();
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
      const src = await db.prepare(SOURCE_FOR_REMOVAL).bind(id).first();
      await db.batch([
        queueRemoval(db, src, user.pseudo || user.first_name, "source_changed"),
        db.prepare("DELETE FROM oauth_states WHERE user_id = ?").bind(id),
        db.prepare("DELETE FROM music_sources WHERE user_id = ?").bind(id),
        db.prepare("UPDATE users SET status = 'onboarding', error_message = NULL WHERE id = ? AND status <> 'suspended'").bind(id),
      ].filter(Boolean));
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
    // venues.proposed_by remis à null). Compte Spotify : tâche de retrait affichée à l'admin.
    async deleteAll() {
      await api.deleteFiles();
      const src = await db.prepare(SOURCE_FOR_REMOVAL).bind(id).first();
      await db.batch([
        queueRemoval(db, src, user.pseudo || user.first_name, "deleted"),
        db.prepare("DELETE FROM users WHERE id = ?").bind(id),
      ].filter(Boolean));
      console.log(`Membre ${id} supprimé le ${nowIso()}`);
    },
  };
  return api;
}

// --- Espace admin (spécification, section 9.3) -----------------------------------------------
// Ce que voit l'admin : statut, connexions, activité, nombre de ★, état de la synchronisation.
// Jamais le contenu (artistes, concerts choisis, préférences).

function newMemberId(prefix = "u_") {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return prefix + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// --- Liens d'invitation (invitation sans adresse e-mail) ------------------------------------
// Jeton aléatoire de 32 octets, transmis une seule fois à l'admin ; seule son empreinte est
// gardée. Le lien sert une fois et expire au bout de INVITATION_DAYS jours.
const INVITATION_DAYS = 7;
const INVITATION_TOKEN = /^[A-Za-z0-9_-]{40,60}$/;

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const cleanFirstName = (value) => {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > 40) throw new HttpError(400, "prénom : 1 à 40 caractères");
  return name;
};

// Invitation valide pour ce jeton : { id, first_name } ou null (inconnue, expirée, déjà utilisée)
export async function findInvitation(env, token) {
  if (!INVITATION_TOKEN.test(String(token || ""))) return null;
  return env.DB.prepare("SELECT id, first_name FROM invitations WHERE token_hash = ? AND expires_at > ?")
    .bind(await tokenHash(token), nowIso()).first();
}

// La personne invitée donne son adresse : elle devient membre (statut invited), le lien est
// effacé (usage unique). Renvoie { email, first_name }.
export async function claimInvitation(env, token, email) {
  const db = env.DB;
  const mail = String(email || "").trim().toLowerCase();
  if (!EMAIL.test(mail) || mail.length > 200) throw new HttpError(400, "adresse e-mail invalide", "bad_email");
  const invitation = await findInvitation(env, token);
  if (!invitation) throw new HttpError(410, "lien expiré ou déjà utilisé", "expired");
  if (await db.prepare("SELECT 1 FROM users WHERE email = ?").bind(mail).first()) {
    throw new HttpError(409, "cette adresse est déjà inscrite : connectez-vous directement", "exists");
  }
  // Effacement d'abord : deux envois simultanés du même lien ne créent qu'un membre
  const taken = await db.prepare("DELETE FROM invitations WHERE id = ? RETURNING first_name").bind(invitation.id).first();
  if (!taken) throw new HttpError(410, "lien déjà utilisé", "expired");
  try {
    await db.prepare("INSERT INTO users (id, email, first_name, role, status, invited_at) VALUES (?, ?, ?, 'member', 'invited', ?)")
      .bind(newMemberId(), mail, taken.first_name, nowIso()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, "cette adresse est déjà inscrite : connectez-vous directement", "exists");
    throw e;
  }
  console.log(`Invitation ${invitation.id} utilisée le ${nowIso()}`);
  return { email: mail, first_name: taken.first_name };
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

    // Lien d'invitation pour un prénom ; le jeton n'est renvoyé qu'ici (et au renouvellement)
    async createInvitationLink({ first_name }) {
      const name = cleanFirstName(first_name);
      const token = newToken();
      const id = newMemberId("i_");
      const expires = new Date(Date.now() + INVITATION_DAYS * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
      await db.prepare("INSERT INTO invitations (id, token_hash, first_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, await tokenHash(token), name, nowIso(), expires).run();
      return { invitation: { id, first_name: name, expires_at: expires }, token };
    },

    async invitations() {
      const { results } = await db.prepare("SELECT id, first_name, created_at, expires_at FROM invitations ORDER BY created_at").all();
      const now = nowIso();
      return results.map((r) => ({ ...r, expired: r.expires_at <= now }));
    },

    // Nouveau lien pour la même invitation : l'ancien ne fonctionne plus
    async renewInvitation(invitationId) {
      if (!/^i_[a-z0-9]{8}$/.test(String(invitationId))) throw new HttpError(400, "identifiant d'invitation invalide");
      const token = newToken();
      const expires = new Date(Date.now() + INVITATION_DAYS * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
      const row = await db.prepare("UPDATE invitations SET token_hash = ?, expires_at = ? WHERE id = ? RETURNING id, first_name, expires_at")
        .bind(await tokenHash(token), expires, invitationId).first();
      if (!row) throw new HttpError(404, "invitation introuvable");
      return { invitation: row, token };
    },

    async deleteInvitation(invitationId) {
      if (!/^i_[a-z0-9]{8}$/.test(String(invitationId))) throw new HttpError(400, "identifiant d'invitation invalide");
      const r = await db.prepare("DELETE FROM invitations WHERE id = ?").bind(invitationId).run();
      if (!r.meta?.changes) throw new HttpError(404, "invitation introuvable");
      return { deleted: true };
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

    // --- Salles : propositions à valider, corrections du catalogue (section 9.3) ----------
    async venues(status) {
      if (!["pending", "approved", "rejected"].includes(status)) throw new HttpError(400, "statut : pending, approved ou rejected");
      const { results } = await db.prepare(
        "SELECT v.id, v.name, v.aliases, v.agenda_url, v.excluded, v.status, v.proposed_at, v.reviewed_at, v.review_note, " +
        "COALESCE(u.pseudo, u.first_name) AS proposed_by_name FROM venues v LEFT JOIN users u ON u.id = v.proposed_by " +
        "WHERE v.status = ? ORDER BY COALESCE(v.proposed_at, v.name)").bind(status).all();
      const out = results.map((v) => ({ ...v, aliases: JSON.parse(v.aliases || "[]"), excluded: Boolean(v.excluded) }));
      if (status !== "approved") {
        for (const v of out) v.overlaps = await overlappingVenues(db, v.id, [v.name, ...v.aliases]);
      }
      return out;
    },

    async venue(venueKey) {
      if (!VENUE_ID.test(String(venueKey)) || String(venueKey).length > 80) throw new HttpError(400, "identifiant de salle invalide");
      const row = await db.prepare("SELECT id, name, status FROM venues WHERE id = ?").bind(venueKey).first();
      if (!row) throw new HttpError(404, "salle introuvable");
      return row;
    },

    // Correction : nom affiché, autres noms, page programme, exclusion (l'identifiant ne change pas)
    async updateVenue(venueKey, { name, aliases, agenda_url, excluded }) {
      const row = await this.venue(venueKey);
      const current = await db.prepare("SELECT agenda_url FROM venues WHERE id = ?").bind(row.id).first();
      const sets = [];
      const values = [];
      if (name !== undefined) {
        const clean = cleanName(name);
        if (clean.length < 2) throw new HttpError(400, "nom de salle : 2 à 80 caractères");
        if (tooGeneric(clean)) throw new HttpError(400, "nom trop général : précisez le nom de la salle", "generic_name");
        const known = await knownVenue(db, clean, row.id);
        if (known) throw new HttpError(409, "ce nom correspond déjà à une autre salle du catalogue", "exists");
        sets.push("name = ?"); values.push(clean);
      }
      if (aliases !== undefined) {
        const list = cleanAliases(aliases);
        for (const alias of list) {
          if (await knownVenue(db, alias, row.id)) throw new HttpError(409, `« ${alias} » désigne déjà une autre salle`, "exists");
        }
        sets.push("aliases = ?"); values.push(JSON.stringify(list));
      }
      if (agenda_url !== undefined && String(agenda_url ?? "").trim() !== (current?.agenda_url || "")) {
        sets.push("agenda_url = ?"); values.push(cleanUrl(agenda_url));
      }
      if (excluded !== undefined) {
        if (typeof excluded !== "boolean") throw new HttpError(400, "excluded : vrai ou faux");
        sets.push("excluded = ?"); values.push(excluded ? 1 : 0);
      }
      if (sets.length) await db.prepare(`UPDATE venues SET ${sets.join(", ")} WHERE id = ?`).bind(...values, row.id).run();
      return (await this.venues(row.status)).find((v) => v.id === row.id);
    },

    // Décision sur une proposition : approved (publiée au prochain traitement) ou rejected
    async reviewVenue(venueKey, status, note) {
      const row = await this.venue(venueKey);
      // En attente, ou refusée puis finalement approuvée (refus par erreur)
      const from = status === "approved" ? ["pending", "rejected"] : ["pending"];
      const r = await db.prepare(`UPDATE venues SET status = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`)
        .bind(status, nowIso(), cleanName(note, 300) || null, row.id, ...from).run();
      if (!r.meta?.changes) throw new HttpError(409, "cette salle n'est pas en attente de validation", "not_pending");
      return { id: row.id, status };
    },

    // --- Spotify : places, demandes à ajouter, comptes à retirer (section 10) -------------
    async spotify() {
      const { results: sources } = await db.prepare(
        "SELECT s.user_id, u.first_name, u.pseudo, s.status, s.spotify_account_name, s.spotify_account_email, " +
        "s.spotify_requested_at, s.spotify_allowlisted_at, s.spotify_refused_at, s.last_sync_status " +
        "FROM music_sources s JOIN users u ON u.id = s.user_id WHERE s.provider = 'spotify' ORDER BY s.spotify_requested_at").all();
      const { results: removals } = await db.prepare(
        "SELECT id, account_name, account_email, member_name, reason, created_at FROM spotify_removals ORDER BY created_at").all();
      const list = sources.map(({ first_name, pseudo, ...r }) => ({ ...r, display_name: pseudo || first_name }));
      return {
        max: spotifyMax(env),
        used: list.length + removals.length,
        requests: list.filter((m) => m.status === "pending_allowlist"),
        members: list.filter((m) => m.status !== "pending_allowlist"),
        removals,
      };
    },

    // L'admin a ajouté le compte dans le tableau de bord Spotify : le membre peut se connecter
    async spotifyAllowlisted(memberId) {
      const row = await target(memberId);
      const r = await db.prepare("UPDATE music_sources SET status = 'ready_to_connect', spotify_allowlisted_at = ? " +
        "WHERE user_id = ? AND provider = 'spotify' AND status = 'pending_allowlist'").bind(nowIso(), memberId).run();
      if (!r.meta?.changes) throw new HttpError(409, "aucune demande Spotify en attente pour ce membre", "no_request");
      return row;
    },

    // L'admin a retiré le compte du tableau de bord Spotify : place libérée, nom et e-mail effacés
    async spotifyRemoved(removalId) {
      if (!/^\d{1,9}$/.test(String(removalId))) throw new HttpError(400, "identifiant de retrait invalide");
      const r = await db.prepare("DELETE FROM spotify_removals WHERE id = ?").bind(Number(removalId)).run();
      if (!r.meta?.changes) throw new HttpError(404, "retrait introuvable");
      return { removed: true };
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
