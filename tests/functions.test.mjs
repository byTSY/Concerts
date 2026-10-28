// Tests des fonctions Cloudflare : jeton Access, barrière du middleware, isolation entre membres.
//   node --test tests/functions.test.mjs
// D1 est simulé par node:sqlite (même schéma, migrations/*.sql), R2 par un objet en mémoire.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { verifyAccess } from "../functions/_lib/access.js";
import { onRequest as middleware } from "../functions/api/_middleware.js";
import * as starRoute from "../functions/api/me/stars/[concert].js";
import * as artistRoute from "../functions/api/me/artists/[key].js";
import { onRequestGet as getMe } from "../functions/api/me/index.js";
import { onRequestGet as getStars } from "../functions/api/me/stars/index.js";
import { onRequestGet as getPrefs } from "../functions/api/me/prefs.js";
import { onRequestGet as getArtists } from "../functions/api/me/artists/index.js";
import { onRequestGet as getConcerts } from "../functions/api/me/concerts.js";
import * as meRoute from "../functions/api/me/index.js";
import * as sourceRoute from "../functions/api/me/source/index.js";
import * as deezerPreviewRoute from "../functions/api/me/source/deezer/index.js";
import * as deezerConfirmRoute from "../functions/api/me/source/deezer/confirm.js";
import * as syncRoute from "../functions/api/me/sync.js";
import * as adminMembers from "../functions/api/admin/members/index.js";
import * as adminMember from "../functions/api/admin/members/[id]/index.js";
import * as adminSuspend from "../functions/api/admin/members/[id]/suspend.js";
import * as adminReactivate from "../functions/api/admin/members/[id]/reactivate.js";
import * as adminRecompute from "../functions/api/admin/members/[id]/recompute.js";
import * as adminRuns from "../functions/api/admin/runs.js";
import * as spotifyRequest from "../functions/api/me/source/spotify/request.js";
import * as spotifyAuthorize from "../functions/api/me/spotify/authorize.js";
import * as spotifyCallback from "../functions/api/me/spotify/callback.js";
import * as adminSpotify from "../functions/api/admin/spotify/index.js";
import * as adminAllowlisted from "../functions/api/admin/spotify/[user]/allowlisted.js";
import * as adminRemoved from "../functions/api/admin/spotify/removals/[id]/removed.js";
import { decryptToken, encryptToken } from "../functions/_lib/tokens.js";
import * as communityRoute from "../functions/api/community/stars.js";
import * as proposalsRoute from "../functions/api/venues/proposals.js";
import * as venuesRoute from "../functions/api/venues/index.js";
import * as favoriteVenue from "../functions/api/me/venues/[id].js";
import * as adminVenues from "../functions/api/admin/venues/index.js";
import * as adminVenue from "../functions/api/admin/venues/[id]/index.js";
import * as adminApprove from "../functions/api/admin/venues/[id]/approve.js";
import * as adminReject from "../functions/api/admin/venues/[id]/reject.js";
import * as adminCheck from "../functions/api/admin/venues/[id]/check.js";
import * as invitationRoute from "../functions/invitation/[[path]].js";
import * as adminInvitations from "../functions/api/admin/invitations/index.js";
import * as adminInvitation from "../functions/api/admin/invitations/[id]/index.js";
import * as adminRenew from "../functions/api/admin/invitations/[id]/renew.js";
import * as adminAccess from "../functions/api/admin/members/[id]/access.js";
import * as seenRoute from "../functions/api/me/seen.js";
import * as removedRoute from "../functions/api/me/removed/[concert].js";
import { onRequestGet as getRemoved } from "../functions/api/me/removed/index.js";
import * as unsubscribeRoute from "../functions/partage/desabonnement/[token].js";
import * as problemRoute from "../functions/api/me/problem.js";
import * as adminProblems from "../functions/api/admin/problems/index.js";
import * as adminProblemResolved from "../functions/api/admin/problems/[id]/resolved.js";
import * as monthSeenRoute from "../functions/api/me/month-seen.js";
import * as guestLinkRoute from "../functions/api/admin/guest-link.js";
import * as visiteRoute from "../functions/visite/[[path]].js";

// --- D1 et R2 simulés --------------------------------------------------------------

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  }
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { raw: db, prepare: (sql) => statement(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

function fakeR2(objects) {
  return {
    objects,
    get: async (key) => (key in objects
      ? { text: async () => objects[key], body: new Response(objects[key]).body }
      : null),
    list: async ({ prefix }) => ({ objects: Object.keys(objects).filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
    delete: async (keys) => { for (const k of [].concat(keys)) delete objects[k]; },
  };
}

// --- Jetons Access signés par une clé de test ------------------------------------------

const TEAM = "equipe.cloudflareaccess.com";
const AUD = "aud-test";
const keys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256" };
const realFetch = globalThis.fetch;
// Deezer simulé : profil 111 public (12 artistes favoris), 222 privé, autres introuvables
const DEEZER = {
  "/user/111": { id: 111, name: "Profil public" }, "/user/111/artists?limit=1": { data: [{}], total: 12 },
  "/user/222": { id: 222, name: "Profil privé" }, "/user/222/artists?limit=1": { error: { type: "OAuthException", code: 200 } },
};
// Spotify simulé : échange du code, profil (/v1/me) ; SPOTIFY.me = 403 : compte non autorisé
const SPOTIFY = { me: { id: "spotify-alice", display_name: "Alice S." }, refresh: "JETON-RAFRAICHISSEMENT-SECRET", exchanges: [] };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === "https://accounts.spotify.com/api/token") {
    SPOTIFY.exchanges.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    return new Response(JSON.stringify({ access_token: "JETON-ACCES-SECRET", refresh_token: SPOTIFY.refresh, scope: "user-library-read" }));
  }
  if (u === "https://api.spotify.com/v1/me") {
    if (SPOTIFY.me === 403) return new Response(JSON.stringify({ error: { status: 403, message: "User not registered" } }), { status: 403 });
    return new Response(JSON.stringify(SPOTIFY.me));
  }
  if (u === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
  if (u.startsWith("https://api.deezer.com")) {
    const path = u.slice("https://api.deezer.com".length);
    return new Response(JSON.stringify(DEEZER[path] || { error: { type: "DataException", code: 800 } }));
  }
  if (u.startsWith("https://api.cloudflare.com") || u.startsWith("https://api.github.com")) {
    throw new Error("appel extérieur inattendu dans les tests");
  }
  return realFetch(url, init);
};

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
async function token(claims, { kid = "k1", key = keys.privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid }));
  const body = b64url(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, iat: now - 60, exp: now + 3600, ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

// --- Contexte de test : deux membres A et B ---------------------------------------------

function setup() {
  const DB = fakeD1();
  const now = "2026-10-12T00:00:00+00:00";
  DB.raw.exec(`
    INSERT INTO users (id, email, first_name, role, status, invited_at) VALUES
      ('u_aaaaaaaa', 'a@test.fr', 'Alice', 'member', 'active', '${now}'),
      ('u_bbbbbbbb', 'b@test.fr', 'Bruno', 'member', 'active', '${now}'),
      ('u_cccccccc', 'c@test.fr', 'Chloé', 'admin', 'active', '${now}');
    INSERT INTO stars (user_id, concert_id, label, created_at, updated_at) VALUES
      ('u_aaaaaaaa', 'aaaaaa111111', 'Concert de A', '${now}', '${now}'),
      ('u_bbbbbbbb', 'bbbbbb222222', 'Concert de B', '${now}', '${now}');
    INSERT INTO artist_prefs (user_id, artist_key, artist_name, hidden, updated_at) VALUES
      ('u_aaaaaaaa', 'artiste a', 'Artiste A', 1, '${now}'),
      ('u_bbbbbbbb', 'artiste b', 'Artiste B', 1, '${now}');
  `);
  const BUCKET = fakeR2({
    "users/u_aaaaaaaa/artists.json": '{"1":{"name":"Artiste A"}}',
    "users/u_bbbbbbbb/artists.json": '{"2":{"name":"Artiste B"}}',
    "users/u_aaaaaaaa/overlay.json": '{"aaaaaa111111":{"kind":"known"}}',
    "users/u_bbbbbbbb/overlay.json": '{"bbbbbb222222":{"kind":"known"}}',
  });
  return { ...ENV, DB, BUCKET };
}

// Requête complète : middleware puis route, comme sur Cloudflare Pages
async function call(env, email, route, { method = "GET", path = "/api/me", params = {}, body, jwt } = {}) {
  const headers = { "cf-access-jwt-assertion": jwt ?? await token({ email }) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(`https://concerts.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const pending = [];
  const context = { request, env, params, data: {}, waitUntil: (p) => pending.push(p) };
  context.next = () => route(context);
  const response = await middleware(context);
  await Promise.all(pending);
  return { status: response.status, data: await response.json() };
}

// --- Tests ----------------------------------------------------------------------------

test("jeton Access : valide accepté, e-mail en minuscules", async () => {
  const req = new Request("https://concerts.test/api/me", { headers: { "cf-access-jwt-assertion": await token({ email: "A@Test.fr" }) } });
  assert.deepEqual((await verifyAccess(req, ENV)).email, "a@test.fr");
});

test("jeton Access : signature, audience, expiration, émetteur et absence refusés", async () => {
  const other = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
  const cases = {
    signature: await token({ email: "a@test.fr" }, { key: other.privateKey }),
    audience: await token({ email: "a@test.fr", aud: ["autre"] }),
    expiration: await token({ email: "a@test.fr", exp: 1000 }),
    emetteur: await token({ email: "a@test.fr", iss: "https://pirate.cloudflareaccess.com" }),
    sans_emetteur: await token({ email: "a@test.fr", iss: undefined }),
    signature_illisible: (await token({ email: "a@test.fr" })).replace(/\.[^.]+$/, ".%%%"),
    sans_email: await token({}),
    illisible: "abc.def.ghi",
    absent: "",
  };
  for (const [name, jwt] of Object.entries(cases)) {
    const req = new Request("https://concerts.test/api/me", { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} });
    await assert.rejects(verifyAccess(req, ENV), (e) => e.status === 401, name);
  }
});

test("raccourci local DEV_ACCESS_EMAIL ignoré hors localhost", async () => {
  const req = new Request("https://concerts-s2k.pages.dev/api/me");
  await assert.rejects(verifyAccess(req, { ...ENV, DEV_ACCESS_EMAIL: "c@test.fr" }), (e) => e.status === 401);
});

test("isolation : chaque membre ne reçoit que ses données", async () => {
  const env = setup();
  const a = { stars: await call(env, "a@test.fr", getStars), prefs: await call(env, "a@test.fr", getPrefs),
    artists: await call(env, "a@test.fr", getArtists), concerts: await call(env, "a@test.fr", getConcerts) };
  assert.deepEqual(a.stars.data.map((s) => s.concert_id), ["aaaaaa111111"]);
  assert.deepEqual(a.prefs.data.hidden, ["Artiste A"]);
  assert.deepEqual(Object.keys(a.artists.data), ["1"]);
  assert.deepEqual(Object.keys(a.concerts.data.overlay), ["aaaaaa111111"]);
  const b = await call(env, "b@test.fr", getStars);
  assert.deepEqual(b.data.map((s) => s.concert_id), ["bbbbbb222222"]);
});

test("isolation : un identifiant de membre dans la requête est sans effet", async () => {
  const env = setup();
  // Paramètres et corps qui désignent B : la route agit toujours pour le membre du jeton (A)
  await call(env, "a@test.fr", starRoute.onRequestPut, {
    method: "PUT", path: "/api/me/stars/bbbbbb222222?user=u_bbbbbbbb",
    params: { concert: "bbbbbb222222", user_id: "u_bbbbbbbb" },
    body: { label: "piège", user_id: "u_bbbbbbbb", user: "u_bbbbbbbb" },
  });
  const rows = env.DB.raw.prepare("SELECT user_id, label FROM stars WHERE concert_id = 'bbbbbb222222' ORDER BY user_id").all();
  assert.deepEqual(rows.map((r) => [r.user_id, r.label]), [["u_aaaaaaaa", "piège"], ["u_bbbbbbbb", "Concert de B"]]);
  await call(env, "a@test.fr", starRoute.onRequestDelete, { method: "DELETE", params: { concert: "bbbbbb222222" } });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM stars WHERE user_id = 'u_bbbbbbbb'").get().n, 1);
  await call(env, "a@test.fr", artistRoute.onRequestPut, {
    method: "PUT", params: { key: "artiste b" }, body: { hidden: false, user_id: "u_bbbbbbbb" },
  });
  assert.equal(env.DB.raw.prepare("SELECT hidden FROM artist_prefs WHERE user_id = 'u_bbbbbbbb'").get().hidden, 1);
});

test("barrière : adresse inconnue, membre suspendu, route admin pour un membre", async () => {
  const env = setup();
  assert.equal((await call(env, "inconnu@test.fr", getMe)).data.code, "not_member");
  env.DB.raw.exec("UPDATE users SET status = 'suspended' WHERE id = 'u_aaaaaaaa'");
  const suspended = await call(env, "a@test.fr", getMe);
  assert.deepEqual([suspended.status, suspended.data.code], [403, "suspended"]);
  const admin = await call(env, "b@test.fr", getMe, { path: "/api/admin/members" });
  assert.deepEqual([admin.status, admin.data.code], [403, "not_admin"]);
  assert.equal((await call(env, "c@test.fr", getMe, { path: "/api/admin/members" })).status, 200);
});

test("connexions et activité : une connexion par valeur iat, compteurs du jour", async () => {
  const env = setup();
  const jwt = await token({ email: "a@test.fr", iat: 1791800000 });
  await call(env, "a@test.fr", getMe, { jwt });
  await call(env, "a@test.fr", getMe, { jwt });
  await call(env, "a@test.fr", starRoute.onRequestPut, { jwt, method: "PUT", params: { concert: "cccccc333333" }, body: { label: "x" } });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM connections WHERE user_id = 'u_aaaaaaaa'").get().n, 1);
  const act = env.DB.raw.prepare("SELECT api_calls, changes FROM activity_daily WHERE user_id = 'u_aaaaaaaa'").get();
  assert.deepEqual([act.api_calls, act.changes], [3, 1]);
});

test("profil : jamais d'identifiant de membre dans la réponse", async () => {
  const env = setup();
  const me = await call(env, "a@test.fr", getMe);
  assert.equal(me.data.display_name, "Alice");
  assert.ok(!JSON.stringify(me.data).includes("u_aaaaaaaa"));
});

test("fiche de partage : artiste du lien retenu seulement s'il figure dans le concert", async () => {
  const { withSharedArtist, artistOf } = await import("../functions/partage/[[path]].js");
  const ev = { id: "x", title: "Soirée Guinga et Yamandu Costa", artists: [] };
  const q = (s) => new URLSearchParams(s);
  assert.equal(artistOf(withSharedArtist(ev, q("a=Yamandu%20Costa&dz=123"))).name, "Yamandu Costa");
  assert.equal(artistOf(withSharedArtist(ev, q("a=Yamandu%20Costa&dz=123"))).deezer, "https://www.deezer.com/artist/123");
  assert.equal(artistOf(withSharedArtist(ev, q("a=Nom%20invent%C3%A9"))).name, ev.title);
  assert.equal(artistOf(withSharedArtist(ev, q("a=Guinga&dz=javascript:x"))).deezer, null);
  assert.equal(artistOf(withSharedArtist({ ...ev, artists: ["Temples"] }, q("a=temples"))).name, "temples");
});

// --- Étape 3 : compte du membre, arrivée, espace admin ------------------------------------

const ALL_TABLES = ["users", "music_sources", "oauth_states", "connections", "activity_daily", "artist_prefs",
  "venue_favorites", "stars", "member_runs", "seen_cards", "removed_concerts"];

test("admin : invitation, refus d'un doublon, liste sans artiste ni concert", async () => {
  const env = setup();
  const invited = await call(env, "c@test.fr", adminMembers.onRequestPost, {
    method: "POST", path: "/api/admin/members", body: { email: " Dora@Test.FR ", first_name: "Dora" } });
  assert.equal(invited.status, 201);
  assert.equal(invited.data.member.email, "dora@test.fr");
  assert.equal(invited.data.access.done, false);  // liste Access non configurée dans les tests
  assert.match(invited.data.member.id, /^u_[a-z0-9]{8}$/);
  const again = await call(env, "c@test.fr", adminMembers.onRequestPost, {
    method: "POST", path: "/api/admin/members", body: { email: "dora@test.fr", first_name: "Dora" } });
  assert.equal(again.status, 409);
  const list = await call(env, "c@test.fr", adminMembers.onRequestGet, { path: "/api/admin/members" });
  assert.equal(list.status, 200);
  const text = JSON.stringify(list.data);
  for (const secret of ["Artiste A", "Artiste B", "aaaaaa111111", "bbbbbb222222", "Concert de A"]) {
    assert.ok(!text.includes(secret), `la liste admin contient ${secret}`);
  }
  assert.equal(list.data.find((m) => m.id === "u_aaaaaaaa").stars, 1);
  const byMember = await call(env, "a@test.fr", adminMembers.onRequestGet, { path: "/api/admin/members" });
  assert.equal(byMember.status, 403);
});

test("admin : suspension (403 avec une session valide), réactivation au statut précédent", async () => {
  const env = setup();
  const s = await call(env, "c@test.fr", adminSuspend.onRequestPost, {
    method: "POST", path: "/api/admin/members/u_aaaaaaaa/suspend", params: { id: "u_aaaaaaaa" } });
  assert.equal(s.data.status, "suspended");
  assert.equal((await call(env, "a@test.fr", getMe)).data.code, "suspended");
  const r = await call(env, "c@test.fr", adminReactivate.onRequestPost, {
    method: "POST", path: "/api/admin/members/u_aaaaaaaa/reactivate", params: { id: "u_aaaaaaaa" } });
  assert.equal(r.data.status, "active");
  assert.equal((await call(env, "a@test.fr", getMe)).status, 200);
  const self = await call(env, "c@test.fr", adminSuspend.onRequestPost, {
    method: "POST", path: "/api/admin/members/u_cccccccc/suspend", params: { id: "u_cccccccc" } });
  assert.equal(self.status, 409);  // l'admin ne peut pas se suspendre
});

test("suppression par l'admin : plus aucune ligne D1 ni objet R2 du membre", async () => {
  const env = setup();
  env.DB.raw.exec(`INSERT INTO music_sources (user_id, provider, provider_user_id, status, refresh_token_enc)
    VALUES ('u_aaaaaaaa', 'deezer', '999', 'connected', 'chiffré')`);
  await call(env, "a@test.fr", getMe);  // crée connexions et activité
  await call(env, "a@test.fr", seenRoute.onRequestPost, { method: "POST", body: { ids: ["aaaaaa111111"] } });
  await call(env, "a@test.fr", removedRoute.onRequestPut, { method: "PUT", params: { concert: "cccccc333333" },
    body: { label: "Concert retiré", date: "2099-01-01" } });
  const del = await call(env, "c@test.fr", adminMember.onRequestDelete, {
    method: "DELETE", path: "/api/admin/members/u_aaaaaaaa", params: { id: "u_aaaaaaaa" } });
  assert.equal(del.data.deleted, true);
  for (const t of ALL_TABLES) {
    const col = t === "users" ? "id" : "user_id";
    assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = 'u_aaaaaaaa'`).get().n, 0, t);
  }
  assert.deepEqual(Object.keys(env.BUCKET.objects).filter((k) => k.includes("u_aaaaaaaa")), []);
  assert.ok(Object.keys(env.BUCKET.objects).some((k) => k.includes("u_bbbbbbbb")));  // B intact
  assert.equal((await call(env, "a@test.fr", getMe)).data.code, "not_member");
});

test("suppression par le membre : double confirmation, puis plus rien", async () => {
  const env = setup();
  const refused = await call(env, "a@test.fr", meRoute.onRequestDelete, { method: "DELETE", body: {} });
  assert.equal(refused.status, 400);
  const done = await call(env, "a@test.fr", meRoute.onRequestDelete, { method: "DELETE", body: { confirm: "SUPPRIMER" } });
  assert.equal(done.data.deleted, true);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'u_aaaaaaaa'").get().n, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM stars WHERE user_id = 'u_aaaaaaaa'").get().n, 0);
  const admin = await call(env, "c@test.fr", meRoute.onRequestDelete, { method: "DELETE", body: { confirm: "SUPPRIMER" } });
  assert.equal(admin.status, 409);  // le compte admin reste
});

test("arrivée : invité, profil Deezer vérifié (public, libre), calcul demandé", async () => {
  const env = setup();
  env.DB.raw.exec(`INSERT INTO users (id, email, first_name, status, invited_at) VALUES ('u_dddddddd', 'd@test.fr', 'Dora', 'invited', 'x');
    INSERT INTO music_sources (user_id, provider, provider_user_id, status) VALUES ('u_bbbbbbbb', 'deezer', '333', 'connected');`);
  await call(env, "d@test.fr", getMe);
  assert.equal(env.DB.raw.prepare("SELECT status FROM users WHERE id = 'u_dddddddd'").get().status, "onboarding");
  const post = (route, profile) => call(env, "d@test.fr", route, { method: "POST", body: { profile } });
  assert.equal((await post(deezerPreviewRoute.onRequestPost, "pas un lien")).status, 400);
  assert.equal((await post(deezerPreviewRoute.onRequestPost, "https://www.deezer.com/fr/profile/222")).data.code, "private_profile");
  assert.equal((await post(deezerPreviewRoute.onRequestPost, "444")).data.code, "not_found");
  DEEZER["/user/333"] = { id: 333, name: "Déjà pris" };
  DEEZER["/user/333/artists?limit=1"] = { data: [], total: 0 };
  assert.equal((await post(deezerPreviewRoute.onRequestPost, "333")).data.code, "taken");
  const preview = await post(deezerPreviewRoute.onRequestPost, "https://www.deezer.com/fr/profile/111?app_id=1");
  assert.deepEqual([preview.data.name, preview.data.favorites], ["Profil public", 12]);
  const confirm = await post(deezerConfirmRoute.onRequestPost, "111");
  assert.equal(confirm.data.status, "computing");
  assert.equal(confirm.data.run.done, false);  // lancement GitHub non configuré dans les tests
  const src = env.DB.raw.prepare("SELECT provider, provider_user_id, status, sync_requested_at FROM music_sources WHERE user_id = 'u_dddddddd'").get();
  assert.deepEqual([src.provider, src.provider_user_id, src.status], ["deezer", "111", "connected"]);
  assert.ok(src.sync_requested_at);
});

test("compte : pseudo unique, une synchronisation par heure, changement de source", async () => {
  const env = setup();
  env.DB.raw.exec(`INSERT INTO music_sources (user_id, provider, provider_user_id, status, last_sync_status) VALUES
    ('u_aaaaaaaa', 'deezer', '111', 'connected', 'ok'), ('u_bbbbbbbb', 'deezer', '555', 'connected', 'private_profile')`);
  const pseudo = await call(env, "a@test.fr", meRoute.onRequestPatch, { method: "PATCH", body: { pseudo: "Ali" } });
  assert.equal(pseudo.data.display_name, "Ali");
  const taken = await call(env, "b@test.fr", meRoute.onRequestPatch, { method: "PATCH", body: { pseudo: "ali" } });
  assert.equal(taken.data.code, "pseudo_taken");
  const vis = await call(env, "a@test.fr", meRoute.onRequestPatch, { method: "PATCH", body: { default_visibility: "members" } });
  assert.equal(vis.data.default_visibility, "members");
  assert.equal((await call(env, "a@test.fr", syncRoute.onRequestPost, { method: "POST" })).status, 200);
  assert.equal((await call(env, "a@test.fr", syncRoute.onRequestPost, { method: "POST" })).data.code, "too_soon");
  // Après un calcul en erreur : un nouvel essai toutes les 10 minutes (version 1.9.0)
  assert.equal((await call(env, "b@test.fr", syncRoute.onRequestPost, { method: "POST" })).status, 200);
  assert.equal((await call(env, "b@test.fr", syncRoute.onRequestPost, { method: "POST" })).data.code, "too_soon");
  env.DB.raw.exec("UPDATE music_sources SET sync_requested_at = '2026-01-01T00:00:00+00:00' WHERE user_id = 'u_bbbbbbbb'");
  assert.equal((await call(env, "b@test.fr", syncRoute.onRequestPost, { method: "POST" })).status, 200);
  const detached = await call(env, "a@test.fr", sourceRoute.onRequestDelete, { method: "DELETE" });
  assert.equal(detached.data.status, "onboarding");
  assert.equal(detached.data.source, null);
  assert.deepEqual(Object.keys(env.BUCKET.objects).filter((k) => k.includes("u_aaaaaaaa")), []);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM stars WHERE user_id = 'u_aaaaaaaa'").get().n, 1);  // ★ gardés
});

test("traitements (admin) : codes seulement, recalcul d'un membre", async () => {
  const env = setup();
  env.DB.raw.exec(`INSERT INTO music_sources (user_id, provider, provider_user_id, status) VALUES ('u_aaaaaaaa', 'deezer', '111', 'connected');
    INSERT INTO runs (id, kind, started_at, status) VALUES (1, 'weekly', 'x', 'ok');
    INSERT INTO member_runs (run_id, user_id, provider, status, error_code) VALUES (1, 'u_bbbbbbbb', 'deezer', 'error', 'private_profile');`);
  const runs = await call(env, "c@test.fr", adminRuns.onRequestGet, { path: "/api/admin/runs" });
  assert.equal(runs.data[0].members[0].error_code, "private_profile");
  const rec = await call(env, "c@test.fr", adminRecompute.onRequestPost, {
    method: "POST", path: "/api/admin/members/u_aaaaaaaa/recompute", params: { id: "u_aaaaaaaa" } });
  assert.equal(rec.data.requested, true);
  const none = await call(env, "c@test.fr", adminRecompute.onRequestPost, {
    method: "POST", path: "/api/admin/members/u_bbbbbbbb/recompute", params: { id: "u_bbbbbbbb" } });
  assert.equal(none.data.code, "no_source");
  const bad = await call(env, "c@test.fr", adminRecompute.onRequestPost, {
    method: "POST", path: "/api/admin/members/x/recompute", params: { id: "x' OR 1=1" } });
  assert.equal(bad.status, 400);
});

test("écritures refusées depuis un autre site (Origin, Sec-Fetch-Site)", async () => {
  const env = setup();
  const send = async (headers) => {
    const request = new Request("https://concerts.test/api/me/sync", {
      method: "POST", headers: { "cf-access-jwt-assertion": await token({ email: "a@test.fr" }), ...headers } });
    const context = { request, env, params: {}, data: {}, waitUntil: () => {} };
    context.next = () => new Response("{}", { status: 200 });
    return (await middleware(context)).status;
  };
  assert.equal(await send({ origin: "https://pirate.example" }), 403);
  assert.equal(await send({ "sec-fetch-site": "cross-site" }), 403);
  assert.equal(await send({ origin: "https://concerts.test", "sec-fetch-site": "same-origin" }), 200);
});

test("arrivée : Deezer en panne n'est pas un profil privé", async () => {
  const env = setup();
  env.DB.raw.exec("UPDATE users SET status = 'onboarding' WHERE id = 'u_aaaaaaaa'");
  DEEZER["/user/777"] = { id: 777, name: "Quota" };
  DEEZER["/user/777/artists?limit=1"] = { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } };
  const r = await call(env, "a@test.fr", deezerPreviewRoute.onRequestPost, { method: "POST", body: { profile: "777" } });
  assert.deepEqual([r.status, r.data.code], [503, "deezer_unavailable"]);
});

test("profil déjà relié : pas de nouveau calcul par la confirmation", async () => {
  const env = setup();
  env.DB.raw.exec("INSERT INTO music_sources (user_id, provider, provider_user_id, status) VALUES ('u_aaaaaaaa', 'deezer', '111', 'connected')");
  const r = await call(env, "a@test.fr", deezerConfirmRoute.onRequestPost, { method: "POST", body: { profile: "111" } });
  assert.equal(r.data.code, "already_connected");
});

// --- Spotify (étape 4) --------------------------------------------------------------------

const TOKEN_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";  // clé de test (octets 0 à 31)
const spotifyEnv = () => ({ ...setup(), SPOTIFY_CLIENT_ID: "client-test", SPOTIFY_CLIENT_SECRET: "secret-client-test", TOKEN_ENC_KEY: TOKEN_KEY });

// Requête de navigation (redirections) : réponse brute
async function navigate(env, email, route, path, params = {}) {
  const request = new Request(`https://concerts.test${path}`, { headers: { "cf-access-jwt-assertion": await token({ email }) } });
  const context = { request, env, params, data: {}, waitUntil: () => {} };
  context.next = () => route(context);
  return middleware(context);
}

// Journaux capturés pendant un test (aucun jeton ne doit y paraître)
function captureLogs() {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => Object.assign(console, saved) };
}

const askSpotify = (env, email, body) => call(env, email, spotifyRequest.onRequestPost, { method: "POST", path: "/api/me/source/spotify/request", body });
const onboard = (env, ids) => env.DB.raw.exec(ids.map((id) =>
  `INSERT INTO users (id, email, first_name, status, invited_at) VALUES ('${id}', '${id}@test.fr', '${id}', 'onboarding', 'x');`).join(""));
const result = (response) => new URL(response.headers.get("location")).search;

test("chiffrement : format commun aux fonctions et au traitement Python, lié au membre", async () => {
  const env = { TOKEN_ENC_KEY: TOKEN_KEY };
  // Échantillon chiffré par src/library/spotify.py avec la même clé
  assert.equal(await decryptToken(env, "u_aaaaaaaa", "v1.W_6ENffxz6yQGR70.e-i3UaQThwx2XIoX7bNFyYtoGYqU6gC1TvW4w6_gIB8"), "jeton-de-test-py");
  const sealed = await encryptToken(env, "u_aaaaaaaa", "abc");
  assert.ok(sealed.startsWith("v1.") && !sealed.includes("abc"));
  assert.equal(await decryptToken(env, "u_aaaaaaaa", sealed), "abc");
  await assert.rejects(decryptToken(env, "u_bbbbbbbb", sealed));  // recopié sur un autre membre : illisible
  await assert.rejects(encryptToken({ TOKEN_ENC_KEY: "trop-courte" }, "u_aaaaaaaa", "abc"));
});

test("Spotify : demande de place, contrôles, la 6e demande est refusée", async () => {
  const env = spotifyEnv();
  onboard(env, ["u_s1aaaaaa", "u_s2aaaaaa", "u_s3aaaaaa", "u_s4aaaaaa", "u_s5aaaaaa", "u_s6aaaaaa"]);
  assert.equal((await askSpotify(env, "u_s1aaaaaa@test.fr", { account_email: "pas-un-mail", account_name: "Sam" })).data.code, "bad_email");
  const first = await askSpotify(env, "u_s1aaaaaa@test.fr", { account_email: " Sam@Mail.FR ", account_name: "Sam Un" });
  assert.deepEqual([first.data.source.status, first.data.source.spotify_account_email], ["pending_allowlist", "sam@mail.fr"]);
  assert.equal((await askSpotify(env, "u_s2aaaaaa@test.fr", { account_email: "sam@mail.fr", account_name: "Autre" })).data.code, "taken");
  // Correction de sa propre demande : pas de place supplémentaire
  assert.equal((await askSpotify(env, "u_s1aaaaaa@test.fr", { account_email: "sam2@mail.fr", account_name: "Sam Un" })).status, 200);
  for (const n of [2, 3, 4, 5]) {
    assert.equal((await askSpotify(env, `u_s${n}aaaaaa@test.fr`, { account_email: `s${n}@mail.fr`, account_name: `Membre ${n}` })).status, 200);
  }
  const sixth = await askSpotify(env, "u_s6aaaaaa@test.fr", { account_email: "s6@mail.fr", account_name: "Membre 6" });
  assert.deepEqual([sixth.status, sixth.data.code], [409, "spotify_full"]);
  assert.equal((await call(env, "u_s6aaaaaa@test.fr", getMe)).data.spotify.full, true);
  // Plafond réglable (SPOTIFY_MAX_USERS)
  assert.equal((await askSpotify({ ...env, SPOTIFY_MAX_USERS: "6" }, "u_s6aaaaaa@test.fr", { account_email: "s6@mail.fr", account_name: "Membre 6" })).status, 200);
  // Membre déjà relié à Deezer : il doit d'abord détacher sa source
  env.DB.raw.exec("INSERT INTO music_sources (user_id, provider, provider_user_id, status) VALUES ('u_aaaaaaaa', 'deezer', '111', 'connected')");
  assert.equal((await askSpotify({ ...env, SPOTIFY_MAX_USERS: "9" }, "a@test.fr", { account_email: "a@mail.fr", account_name: "Alice" })).data.code, "source_attached");
});

test("Spotify : admin (places, Fait), autorisation, retour et jeton chiffré", async () => {
  const env = spotifyEnv();
  const logs = captureLogs();
  try {
    env.DB.raw.exec("UPDATE users SET status = 'onboarding' WHERE id = 'u_aaaaaaaa'");
    await askSpotify(env, "a@test.fr", { account_email: "alice@mail.fr", account_name: "Alice Martin" });
    // Pas encore ouvert par l'admin : pas d'autorisation possible
    assert.equal(result(await navigate(env, "a@test.fr", spotifyAuthorize.onRequestGet, "/api/me/spotify/authorize")), "?spotify=not_ready");
    assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM oauth_states").get().n, 0);
    // Route admin interdite à un membre
    assert.equal((await call(env, "a@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" })).status, 403);
    const sp = await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" });
    assert.deepEqual([sp.data.used, sp.data.max, sp.data.requests[0].spotify_account_email], [1, 5, "alice@mail.fr"]);
    assert.equal(sp.data.dashboard_url, "https://developer.spotify.com/dashboard/client-test/users");
    const done = await call(env, "c@test.fr", adminAllowlisted.onRequestPost, {
      method: "POST", path: "/api/admin/spotify/u_aaaaaaaa/allowlisted", params: { user: "u_aaaaaaaa" } });
    assert.equal(done.data.status, "ready_to_connect");

    const go = await navigate(env, "a@test.fr", spotifyAuthorize.onRequestGet, "/api/me/spotify/authorize");
    assert.equal(go.status, 302);
    const target = new URL(go.headers.get("location"));
    assert.equal(target.origin + target.pathname, "https://accounts.spotify.com/authorize");
    assert.equal(target.searchParams.get("code_challenge_method"), "S256");
    assert.equal(target.searchParams.get("redirect_uri"), "https://concerts.test/api/me/spotify/callback");
    const state = target.searchParams.get("state");
    const stored = env.DB.raw.prepare("SELECT user_id, code_verifier FROM oauth_states WHERE state = ?").get(state);
    assert.equal(stored.user_id, "u_aaaaaaaa");
    assert.equal(target.searchParams.get("code_challenge"),
      Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stored.code_verifier))).toString("base64url"));

    // B termine le retour avec le state de A : refusé, rien ne change, le state de A reste valable
    const exchanges = SPOTIFY.exchanges.length;
    const cross = await navigate(env, "b@test.fr", spotifyCallback.onRequestGet, `/api/me/spotify/callback?code=c1&state=${state}`);
    assert.equal(result(cross), "?spotify=bad_state");
    assert.equal(SPOTIFY.exchanges.length, exchanges);
    assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM music_sources WHERE user_id = 'u_bbbbbbbb'").get().n, 0);

    const back = await navigate(env, "a@test.fr", spotifyCallback.onRequestGet, `/api/me/spotify/callback?code=c1&state=${state}`);
    assert.equal(result(back), "?spotify=ok_later");  // relié ; calcul non lancé (pas de clé GitHub dans les tests)
    assert.equal(SPOTIFY.exchanges.at(-1).code_verifier, stored.code_verifier);
    const src = env.DB.raw.prepare("SELECT * FROM music_sources WHERE user_id = 'u_aaaaaaaa'").get();
    assert.deepEqual([src.status, src.provider_user_id, src.provider_name], ["connected", "spotify-alice", "Alice S."]);
    assert.equal(await decryptToken(env, "u_aaaaaaaa", src.refresh_token_enc), SPOTIFY.refresh);
    assert.equal(env.DB.raw.prepare("SELECT status FROM users WHERE id = 'u_aaaaaaaa'").get().status, "computing");
    // State à usage unique
    const again = await navigate(env, "a@test.fr", spotifyCallback.onRequestGet, `/api/me/spotify/callback?code=c1&state=${state}`);
    assert.equal(result(again), "?spotify=bad_state");

    // Aucun jeton en clair : base, stockage, réponses d'API, journaux
    const dump = JSON.stringify([
      env.DB.raw.prepare("SELECT * FROM music_sources").all(), env.DB.raw.prepare("SELECT * FROM oauth_states").all(),
      env.BUCKET.objects,
      (await call(env, "a@test.fr", getMe)).data,
      (await call(env, "c@test.fr", adminMembers.onRequestGet, { path: "/api/admin/members" })).data,
      (await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" })).data,
      logs.lines,
    ]);
    assert.ok(!dump.includes("SECRET"), "jeton en clair trouvé");
    const exposed = JSON.stringify([(await call(env, "a@test.fr", getMe)).data,
      (await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" })).data]);
    assert.ok(!exposed.includes("v1."), "jeton chiffré exposé dans une réponse");
  } finally {
    logs.restore();
  }
});

test("Spotify : compte refusé par Spotify, retour à la demande avec mention pour l'admin", async () => {
  const env = spotifyEnv();
  env.DB.raw.exec(`UPDATE users SET status = 'onboarding' WHERE id = 'u_aaaaaaaa';
    INSERT INTO music_sources (user_id, provider, status, spotify_account_email, spotify_account_name, spotify_allowlisted_at)
    VALUES ('u_aaaaaaaa', 'spotify', 'ready_to_connect', 'alice@mail.fr', 'Alice', 'x')`);
  const go = await navigate(env, "a@test.fr", spotifyAuthorize.onRequestGet, "/api/me/spotify/authorize");
  const state = new URL(go.headers.get("location")).searchParams.get("state");
  SPOTIFY.me = 403;
  try {
    const back = await navigate(env, "a@test.fr", spotifyCallback.onRequestGet, `/api/me/spotify/callback?code=c2&state=${state}`);
    assert.equal(result(back), "?spotify=not_allowlisted");
  } finally {
    SPOTIFY.me = { id: "spotify-alice", display_name: "Alice S." };
  }
  const src = env.DB.raw.prepare("SELECT status, spotify_refused_at, refresh_token_enc FROM music_sources WHERE user_id = 'u_aaaaaaaa'").get();
  assert.equal(src.status, "pending_allowlist");
  assert.ok(src.spotify_refused_at);
  assert.equal(src.refresh_token_enc, null);
  const sp = await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" });
  assert.ok(sp.data.requests[0].spotify_refused_at);
  // Annulation chez Spotify : rien n'est relié
  await call(env, "c@test.fr", adminAllowlisted.onRequestPost, { method: "POST", path: "/api/admin/spotify/u_aaaaaaaa/allowlisted", params: { user: "u_aaaaaaaa" } });
  const go2 = await navigate(env, "a@test.fr", spotifyAuthorize.onRequestGet, "/api/me/spotify/authorize");
  const state2 = new URL(go2.headers.get("location")).searchParams.get("state");
  const denied = await navigate(env, "a@test.fr", spotifyCallback.onRequestGet, `/api/me/spotify/callback?error=access_denied&state=${state2}`);
  assert.equal(result(denied), "?spotify=denied");
  assert.equal(env.DB.raw.prepare("SELECT status FROM music_sources WHERE user_id = 'u_aaaaaaaa'").get().status, "ready_to_connect");
});

test("Spotify : suppression et changement de source créent un retrait ; « Retiré » libère la place", async () => {
  const env = spotifyEnv();
  env.DB.raw.exec(`INSERT INTO music_sources (user_id, provider, provider_user_id, status, refresh_token_enc, spotify_account_email, spotify_account_name, spotify_allowlisted_at) VALUES
    ('u_aaaaaaaa', 'spotify', 'sp-a', 'connected', 'v1.x.y', 'alice@mail.fr', 'Alice', 'x'),
    ('u_bbbbbbbb', 'spotify', 'sp-b', 'connected', 'v1.x.z', 'bruno@mail.fr', 'Bruno', 'x');
    INSERT INTO oauth_states (state, user_id, code_verifier, expires_at) VALUES ('etat-de-test-aaaaaaaaaaaa', 'u_aaaaaaaa', 'v', 'x');`);
  await call(env, "c@test.fr", adminMember.onRequestDelete, { method: "DELETE", path: "/api/admin/members/u_aaaaaaaa", params: { id: "u_aaaaaaaa" } });
  for (const t of ALL_TABLES) {
    const col = t === "users" ? "id" : "user_id";
    assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = 'u_aaaaaaaa'`).get().n, 0, t);
  }
  await call(env, "b@test.fr", sourceRoute.onRequestDelete, { method: "DELETE" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM music_sources WHERE refresh_token_enc IS NOT NULL").get().n, 0);
  const sp = await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" });
  assert.deepEqual(sp.data.removals.map((r) => [r.account_email, r.reason]), [["alice@mail.fr", "deleted"], ["bruno@mail.fr", "source_changed"]]);
  assert.equal(sp.data.used, 2);  // places gardées tant que l'admin n'a pas retiré les comptes chez Spotify
  for (const r of sp.data.removals) {
    const done = await call(env, "c@test.fr", adminRemoved.onRequestPost, {
      method: "POST", path: `/api/admin/spotify/removals/${r.id}/removed`, params: { id: String(r.id) } });
    assert.equal(done.data.removed, true);
  }
  const after = await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" });
  assert.equal(after.data.used, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM spotify_removals").get().n, 0);
});

test("Spotify : le même compte redemandé après un changement de source n'occupe qu'une place", async () => {
  const env = spotifyEnv();
  env.DB.raw.exec(`INSERT INTO music_sources (user_id, provider, provider_user_id, status, spotify_account_email, spotify_account_name, spotify_allowlisted_at)
    VALUES ('u_aaaaaaaa', 'spotify', 'sp-a', 'connected', 'alice@mail.fr', 'Alice', 'x')`);
  await call(env, "a@test.fr", sourceRoute.onRequestDelete, { method: "DELETE" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM spotify_removals").get().n, 1);
  const again = await askSpotify(env, "a@test.fr", { account_email: "Alice@mail.fr", account_name: "Alice" });
  assert.equal(again.data.source.status, "ready_to_connect");  // toujours inscrit chez Spotify : pas d'attente
  const sp = await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" });
  assert.deepEqual([sp.data.used, sp.data.removals.length], [1, 0]);
  // SPOTIFY_MAX_USERS = 0 ferme Spotify ; clé mal formée : Spotify non proposé
  assert.equal((await askSpotify({ ...env, SPOTIFY_MAX_USERS: "0" }, "b@test.fr", { account_email: "b@mail.fr", account_name: "Bruno" })).data.code, "spotify_full");
  assert.equal((await call({ ...env, TOKEN_ENC_KEY: "abc" }, "b@test.fr", getMe)).data.spotify.enabled, false);
});

test("fonctions déployées avant la migration 0003 : le profil reste lisible, Spotify non proposé", async () => {
  const env = spotifyEnv();
  env.DB.raw.exec("DROP TABLE spotify_removals");
  const me = await call(env, "a@test.fr", getMe);
  assert.equal(me.status, 200);
  assert.equal(me.data.spotify.enabled, false);
});

test("fiche de partage : concert lu dans son petit fichier, events.json complet à défaut", async () => {
  const { findConcert } = await import("../functions/partage/[[path]].js");
  const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const served = [];
  const env = (files) => ({ ASSETS: { fetch: async (u) => {
    served.push(u.pathname);
    return files[u.pathname]?.() ?? new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  } } });
  const withShards = env({ "/data/share/ab.json": () => json([{ id: "ab12cd34ef56", title: "Concert" }]) });
  assert.equal((await findConcert(withShards, "https://x.test/partage/ab12cd34ef56", "ab12cd34ef56")).title, "Concert");
  assert.equal(await findConcert(withShards, "https://x.test/", "ab0000000000"), null);
  assert.ok(!served.includes("/data/events.json"));
  assert.equal(await findConcert(withShards, "https://x.test/", "zzzzzz"), null);  // refusé sans lecture
  assert.ok(!served.includes("/data/share/zz.json"));
  const before = env({ "/data/events.json": () => json([{ id: "cd12cd34ef56", title: "Ancien" }]) });
  assert.equal((await findConcert(before, "https://x.test/", "cd12cd34ef56")).title, "Ancien");
});

// --- Communauté (étape 5) -------------------------------------------------------------------

test("★ partagés : jamais un ★ privé, jamais un membre suspendu, ni identifiant ni ses propres ★", async () => {
  const env = setup();
  const now = "2026-10-13T00:00:00+00:00";
  env.DB.raw.exec(`UPDATE stars SET visibility = 'members' WHERE user_id = 'u_bbbbbbbb';
    INSERT INTO stars (user_id, concert_id, label, status, visibility, created_at, updated_at) VALUES
      ('u_bbbbbbbb', 'cccccc333333', 'Privé de B', 'going', 'private', '${now}', '${now}'),
      ('u_aaaaaaaa', 'dddddd444444', 'Partagé par A', 'going', 'members', '${now}', '${now}');
    UPDATE users SET pseudo = 'Bubu' WHERE id = 'u_bbbbbbbb';`);
  const seenByC = (await call(env, "c@test.fr", communityRoute.onRequestGet, { path: "/api/community/stars" })).data;
  assert.deepEqual(seenByC.map((s) => [s.concert_id, s.name, s.status]).sort(),
    [["bbbbbb222222", "Bubu", "interested"], ["dddddd444444", "Alice", "going"]]);
  assert.ok(!JSON.stringify(seenByC).includes("u_"), "identifiant de membre exposé");
  assert.ok(!JSON.stringify(seenByC).includes("cccccc333333"), "★ privé exposé");
  // A ne reçoit pas ses propres ★ ; B suspendu disparaît aussitôt
  const seenByA = (await call(env, "a@test.fr", communityRoute.onRequestGet, { path: "/api/community/stars" })).data;
  assert.deepEqual(seenByA.map((s) => s.concert_id), ["bbbbbb222222"]);
  env.DB.raw.exec("UPDATE users SET status = 'suspended' WHERE id = 'u_bbbbbbbb'");
  const afterSuspend = (await call(env, "c@test.fr", communityRoute.onRequestGet, { path: "/api/community/stars" })).data;
  assert.deepEqual(afterSuspend.map((s) => s.concert_id), ["dddddd444444"]);
  // Retrait du partage par A (visibilité privée) : disparaît aussi
  await call(env, "a@test.fr", starRoute.onRequestPut, {
    method: "PUT", path: "/api/me/stars/dddddd444444", params: { concert: "dddddd444444" }, body: { visibility: "private" } });
  assert.deepEqual((await call(env, "c@test.fr", communityRoute.onRequestGet, { path: "/api/community/stars" })).data, []);
});

test("★ : statut « places prises » et visibilité par défaut du membre", async () => {
  const env = setup();
  await call(env, "a@test.fr", meRoute.onRequestPatch, { method: "PATCH", body: { default_visibility: "members" } });
  const put = (body) => call(env, "a@test.fr", starRoute.onRequestPut, {
    method: "PUT", path: "/api/me/stars/eeeeee555555", params: { concert: "eeeeee555555" }, body });
  let list = (await put({ label: "Concert E" })).data;
  assert.deepEqual([list.at(-1).status, list.at(-1).visibility], ["interested", "members"]);
  list = (await put({ status: "going" })).data;
  assert.deepEqual([list.at(-1).status, list.at(-1).visibility, list.at(-1).label], ["going", "members", "Concert E"]);
  assert.equal((await put({ status: "peut-etre" })).status, 400);
});

test("salles : proposition, doublons, plafond, validation par l'admin, auteur jamais montré aux membres", async () => {
  const env = setup();
  env.DB.raw.exec(`INSERT INTO venues (id, name, aliases, status) VALUES ('bellevilloise', 'La Bellevilloise', '["Bellevilloise Paris"]', 'approved')`);
  const propose = (email, body) => call(env, email, proposalsRoute.onRequestPost, { method: "POST", path: "/api/venues/proposals", body });
  assert.equal((await propose("a@test.fr", { name: "x" })).data.code, "bad_name");
  assert.equal((await propose("a@test.fr", { name: "Bellevilloise" })).data.code, "exists");          // nom sans article
  assert.equal((await propose("a@test.fr", { name: "bellevilloise paris" })).data.code, "exists");    // autre nom connu
  assert.equal((await propose("a@test.fr", { name: "Le Petit Bain", agenda_url: "javascript:alert(1)" })).data.code, "bad_url");
  const ok = await propose("a@test.fr", { name: " Le  Petit Bain ", aliases: "Petit Bain, Petit-Bain", agenda_url: "https://petitbain.org/agenda" });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.data[0].id, ok.data[0].name, ok.data[0].status], ["petit-bain", "Le Petit Bain", "pending"]);
  assert.equal((await propose("b@test.fr", { name: "Petit Bain" })).data.code, "exists");
  for (const n of [2, 3, 4, 5]) assert.equal((await propose("a@test.fr", { name: `Salle numéro ${n}` })).status, 201);
  assert.equal((await propose("a@test.fr", { name: "Salle numéro 6" })).data.code, "too_many");
  // B ne voit ni les propositions de A, ni leur auteur ; le catalogue public ne montre que les salles approuvées
  assert.deepEqual((await call(env, "b@test.fr", proposalsRoute.onRequestGet, { path: "/api/venues/proposals" })).data, []);
  const catalog = (await call(env, "b@test.fr", venuesRoute.onRequestGet, { path: "/api/venues" })).data;
  assert.deepEqual(catalog.map((v) => v.id), ["bellevilloise"]);
  assert.ok(!JSON.stringify(catalog).includes("proposed"));
  // Admin : liste, correction, validation ; un membre n'a pas accès
  assert.equal((await call(env, "a@test.fr", adminVenues.onRequestGet, { path: "/api/admin/venues" })).status, 403);
  const pending = (await call(env, "c@test.fr", adminVenues.onRequestGet, { path: "/api/admin/venues?status=pending" })).data;
  assert.equal(pending.find((v) => v.id === "petit-bain").proposed_by_name, "Alice");
  const fixed = await call(env, "c@test.fr", adminVenue.onRequestPatch, {
    method: "PATCH", path: "/api/admin/venues/petit-bain", params: { id: "petit-bain" }, body: { aliases: ["Petit Bain", "Le Petit-Bain"] } });
  assert.deepEqual(fixed.data.aliases, ["Petit Bain", "Le Petit-Bain"]);
  const approved = await call(env, "c@test.fr", adminApprove.onRequestPost, {
    method: "POST", path: "/api/admin/venues/petit-bain/approve", params: { id: "petit-bain" } });
  assert.equal(approved.data.status, "approved");
  assert.equal((await call(env, "c@test.fr", adminApprove.onRequestPost, {
    method: "POST", path: "/api/admin/venues/petit-bain/approve", params: { id: "petit-bain" } })).data.code, "not_pending");
  await call(env, "c@test.fr", adminReject.onRequestPost, {
    method: "POST", path: "/api/admin/venues/salle-numero-2/reject", params: { id: "salle-numero-2" }, body: { note: "Hors zone" } });
  const mine = (await call(env, "a@test.fr", proposalsRoute.onRequestGet, { path: "/api/venues/proposals" })).data;
  assert.equal(mine.find((v) => v.id === "salle-numero-2").review_note, "Hors zone");
  // Salle approuvée : au catalogue et utilisable comme favorite ; suppression du membre : auteur effacé
  assert.ok((await call(env, "b@test.fr", venuesRoute.onRequestGet, { path: "/api/venues" })).data.some((v) => v.id === "petit-bain"));
  assert.equal((await call(env, "b@test.fr", favoriteVenue.onRequestPut, {
    method: "PUT", path: "/api/me/venues/petit-bain", params: { id: "petit-bain" } })).status, 200);
  await call(env, "a@test.fr", meRoute.onRequestDelete, { method: "DELETE", body: { confirm: "SUPPRIMER" } });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM venues WHERE proposed_by IS NOT NULL").get().n, 0);
});

test("salles : autres noms trop généraux refusés, https exigé, recoupements signalés, refus réversible", async () => {
  const env = setup();
  env.DB.raw.exec(`INSERT INTO venues (id, name, aliases, status) VALUES ('elysee-montmartre', 'Élysée Montmartre', '[]', 'approved');
    INSERT INTO users (id, email, first_name, status, invited_at) VALUES ('u_dddddddd', 'd@test.fr', 'Dora', 'invited', 'x');
    INSERT INTO stars (user_id, concert_id, label, visibility, created_at, updated_at) VALUES ('u_dddddddd', 'ffffff666666', 'x', 'members', 'x', 'x');`);
  const propose = (body) => call(env, "a@test.fr", proposalsRoute.onRequestPost, { method: "POST", path: "/api/venues/proposals", body });
  assert.equal((await propose({ name: "Péniche X", aliases: "Paris" })).data.code, "generic_alias");
  assert.equal((await propose({ name: "Péniche X", aliases: "la" })).data.code, "generic_alias");
  assert.equal((await propose({ name: "Jazz Club" })).data.code, "generic_name");
  assert.equal((await propose({ name: "Péniche X", aliases: "Auditorium" })).data.code, "generic_alias");
  assert.equal((await propose({ name: "Péniche X", agenda_url: "http://peniche.fr" })).data.code, "bad_url");
  assert.equal((await propose({ name: "Péniche X", agenda_url: "https://127.0.0.1/agenda" })).data.code, "bad_url");
  assert.equal((await propose({ name: "Elysée" })).status, 201);
  const pending = (await call(env, "c@test.fr", adminVenues.onRequestGet, { path: "/api/admin/venues?status=pending" })).data;
  assert.deepEqual(pending.find((v) => v.id === "elysee").overlaps, ["Élysée Montmartre"]);
  await call(env, "c@test.fr", adminReject.onRequestPost, { method: "POST", path: "/api/admin/venues/elysee/reject", params: { id: "elysee" } });
  const again = await call(env, "c@test.fr", adminApprove.onRequestPost, { method: "POST", path: "/api/admin/venues/elysee/approve", params: { id: "elysee" } });
  assert.equal(again.data.status, "approved");
  // Membre seulement invité : ses ★ ne sont pas montrés
  assert.deepEqual((await call(env, "c@test.fr", communityRoute.onRequestGet, { path: "/api/community/stars" })).data, []);
});

// --- Liens d'invitation -------------------------------------------------------------------

// Page publique /invitation/<jeton> (hors /api : pas de jeton Access)
// Navigateur simulé : le cookie déposé à l'inscription est renvoyé ensuite (env.cookie) ;
// otherBrowser : autre navigateur, sans ce cookie
async function invitationPage(env, token, { method = "GET", form, headers = {}, otherBrowser = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (env.cookie && !otherBrowser) init.headers.cookie = env.cookie;
  if (form) {
    init.body = new URLSearchParams(form).toString();
    init.headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const pending = [];
  const r = await invitationRoute.onRequest({ request: new Request(`https://concerts.test/invitation/${token}`, init), env,
    params: { path: [token] }, waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const set = r.headers.get("set-cookie");
  if (set && !otherBrowser) env.cookie = set.split(";")[0];
  return { status: r.status, html: await r.text(), headers: r.headers };
}

test("lien d'invitation : créé par l'admin, jeton jamais gardé en clair, usage unique", async () => {
  const env = setup();
  assert.equal((await call(env, "a@test.fr", adminInvitations.onRequestPost, { method: "POST", path: "/api/admin/invitations", body: { first_name: "Hugo" } })).status, 403);
  const created = await call(env, "c@test.fr", adminInvitations.onRequestPost, { method: "POST", path: "/api/admin/invitations", body: { first_name: " Hugo " } });
  assert.equal(created.status, 201);
  const link = new URL(created.data.link);
  assert.equal(link.origin, "https://concerts.test");
  const token = link.pathname.split("/").pop();
  assert.ok(!JSON.stringify(env.DB.raw.prepare("SELECT * FROM invitations").all()).includes(token), "jeton gardé en clair");
  const listed = (await call(env, "c@test.fr", adminInvitations.onRequestGet, { path: "/api/admin/invitations" })).data;
  assert.deepEqual([listed.length, listed[0].first_name, listed[0].expired], [1, "Hugo", false]);
  assert.ok(!JSON.stringify(listed).includes(token));

  const page = await invitationPage(env, token);
  assert.equal(page.status, 200);
  assert.match(page.html, /Bonjour Hugo/);
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  assert.equal((await invitationPage(env, "x".repeat(43))).status, 410);                       // jeton inconnu
  // Envoi depuis un autre site : refusé ; adresses différentes : formulaire à nouveau
  assert.equal((await invitationPage(env, token, { method: "POST", form: { email: "h@x.fr", email2: "h@x.fr" }, headers: { origin: "https://pirate.example" } })).status, 403);
  assert.equal((await invitationPage(env, token, { method: "POST", form: { email: "h@x.fr", email2: "h@x.fr" }, headers: { "sec-fetch-site": "cross-site", origin: "null" } })).status, 403);
  // Formulaire de la page elle-même, origine masquée par le navigateur : accepté (adresse invalide ici)
  assert.match((await invitationPage(env, token, { method: "POST", form: { email: "pas-un-mail" }, headers: { "sec-fetch-site": "same-origin", origin: "null" } })).html, /adresse e-mail invalide/);
  assert.match((await invitationPage(env, token, { method: "POST", form: { email: "A@test.fr" } })).html, /déjà inscrite/);
  // Une seule saisie de l'adresse (version 1.13.0) ; Spotify non configuré : pas de choix proposé
  assert.doesNotMatch(page.html, /email2|value="spotify"/);
  const done = await invitationPage(env, token, { method: "POST", form: { email: "Hugo@Mail.FR" } });
  assert.match(done.html, /C&#39;est fait|C'est fait/);
  assert.match(done.html, /class="address">hugo@mail\.fr</);
  const user = env.DB.raw.prepare("SELECT id, first_name, status, role, invited_via, access_pending, default_visibility FROM users WHERE email = 'hugo@mail.fr'").get();
  assert.deepEqual([user.first_name, user.status, user.role, user.invited_via, user.default_visibility], ["Hugo", "invited", "member", "link", "members"]);
  // Liste Access non configurée dans les tests : échec signalé à l'admin, qui peut relancer
  assert.equal(user.access_pending, 1);
  const members = (await call(env, "c@test.fr", adminMembers.onRequestGet, { path: "/api/admin/members" })).data;
  assert.equal(members.find((m) => m.email === "hugo@mail.fr").access_pending, 1);
  const retry = await call(env, "c@test.fr", adminAccess.onRequestPost, { method: "POST", path: `/api/admin/members/${user.id}/access`, params: { id: user.id } });
  assert.equal(retry.data.access.done, false);
  assert.equal((await call(env, "a@test.fr", adminAccess.onRequestPost, { method: "POST", path: `/api/admin/members/${user.id}/access`, params: { id: user.id } })).status, 403);
  // Lien utilisé : gardé 24 heures pour la correction, absent de la liste des liens, plus de second membre
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM invitations WHERE claimed_by = ?").get(user.id).n, 1);
  assert.equal((await call(env, "c@test.fr", adminInvitations.onRequestGet, { path: "/api/admin/invitations" })).data.length, 0);
  assert.equal((await invitationPage(env, token)).status, 200);
  assert.match((await invitationPage(env, token)).html, /class="address">hugo@mail\.fr</);
  // La personne inscrite se connecte ensuite normalement ; le lien ne sert plus
  assert.equal((await call(env, "hugo@mail.fr", getMe)).data.first_name, "Hugo");
  assert.equal((await invitationPage(env, token)).status, 410);
  assert.equal((await invitationPage(env, token, { method: "POST", form: { action: "correct", email: "autre@mail.fr" } })).status, 410);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'autre@mail.fr'").get().n, 0);
});

// Notifications en file (même lecture que queued, plus bas)
const notes = (env) => env.DB.raw.prepare("SELECT kind, user_id, to_admin, payload FROM notifications ORDER BY id").all()
  .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

test("lien d'invitation : adresse corrigée dans les 24 heures, avant la première connexion", async () => {
  const env = setup();
  const created = await call(env, "c@test.fr", adminInvitations.onRequestPost, { method: "POST", path: "/api/admin/invitations", body: { first_name: "Léa" } });
  const token = new URL(created.data.link).pathname.split("/").pop();
  await invitationPage(env, token, { method: "POST", form: { email: "lea@gmial.com" } });
  const id = env.DB.raw.prepare("SELECT id FROM users WHERE email = 'lea@gmial.com'").get().id;
  // Cookie de l'inscription : HttpOnly, limité à /invitation/, secret gardé en empreinte seulement
  const secret = env.cookie.split("=")[1];
  assert.ok(secret.length >= 40);
  assert.ok(!JSON.stringify(env.DB.raw.prepare("SELECT * FROM invitations").all()).includes(secret), "secret gardé en clair");
  // Lien transféré ou retrouvé ailleurs : ni adresse affichée, ni correction possible
  const elsewhere = await invitationPage(env, token, { otherBrowser: true });
  assert.equal(elsewhere.status, 410);
  assert.doesNotMatch(elsewhere.html, /gmial/);
  assert.equal((await invitationPage(env, token, { method: "POST", form: { action: "correct", email: "pirate@x.fr" }, otherBrowser: true })).status, 410);
  assert.equal(env.DB.raw.prepare("SELECT email FROM users WHERE id = ?").get(id).email, "lea@gmial.com");
  // Formulaire d'inscription renvoyé (second onglet) : pas pris pour une correction
  assert.match((await invitationPage(env, token, { method: "POST", form: { email: "autre@x.fr" } })).html, /class="address">lea@gmial\.com</);
  assert.equal(env.DB.raw.prepare("SELECT email FROM users WHERE id = ?").get(id).email, "lea@gmial.com");
  // Envoi depuis un autre site : refusé
  assert.equal((await invitationPage(env, token, { method: "POST", form: { action: "correct", email: "x@x.fr" }, headers: { origin: "https://pirate.example" } })).status, 403);
  // Adresse d'un autre membre ou invalide : refus, l'adresse reste
  assert.match((await invitationPage(env, token, { method: "POST", form: { action: "correct", email: "a@test.fr" } })).html, /déjà inscrite/);
  assert.match((await invitationPage(env, token, { method: "POST", form: { action: "correct", email: "nope" } })).html, /invalide/);
  const fixed = await invitationPage(env, token, { method: "POST", form: { action: "correct", email: " Lea@Gmail.com " } });
  assert.match(fixed.html, /Adresse corrigée/);
  assert.match(fixed.html, /class="address">lea@gmail\.com</);
  assert.equal(env.DB.raw.prepare("SELECT email FROM users WHERE id = ?").get(id).email, "lea@gmail.com");
  assert.ok(notes(env).some((n) => n.kind === "member_joined" && n.payload.corrected === true));
  // Même membre (pas de doublon) ; l'ancienne adresse n'ouvre plus rien
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE first_name = 'Léa'").get().n, 1);
  assert.equal((await call(env, "lea@gmial.com", getMe)).status, 403);
  // Trois corrections au plus
  await invitationPage(env, token, { method: "POST", form: { action: "correct", email: "lea2@gmail.com" } });
  await invitationPage(env, token, { method: "POST", form: { action: "correct", email: "lea3@gmail.com" } });
  assert.match((await invitationPage(env, token, { method: "POST", form: { action: "correct", email: "lea4@gmail.com" } })).html, /3 corrections au plus/);
  assert.equal(env.DB.raw.prepare("SELECT email FROM users WHERE id = ?").get(id).email, "lea3@gmail.com");
  assert.equal((await call(env, "lea3@gmail.com", getMe)).data.first_name, "Léa");
  // Délai passé : lien expiré, effacé à la lecture de la liste des liens
  env.DB.raw.exec("UPDATE invitations SET expires_at = '2020-01-01T00:00:00+00:00'");
  assert.equal((await invitationPage(env, token)).status, 410);
  await call(env, "c@test.fr", adminInvitations.onRequestGet, { path: "/api/admin/invitations" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM invitations").get().n, 0);
});

test("lien d'invitation : Spotify choisi sur la page, demande envoyée à l'admin avant la connexion", async () => {
  const env = { ...spotifyEnv(), SPOTIFY_MAX_USERS: "1" };
  const link = async (first_name) => new URL((await call(env, "c@test.fr", adminInvitations.onRequestPost,
    { method: "POST", path: "/api/admin/invitations", body: { first_name } })).data.link).pathname.split("/").pop();
  const token = await link("Tom");
  const page = await invitationPage(env, token);
  assert.match(page.html, /value="spotify"/);
  // Adresse Spotify vide : celle de connexion
  const done = await invitationPage(env, token, { method: "POST", form: { email: "tom@mail.fr", source: "spotify", spotify_email: "" } });
  assert.match(done.html, /demande Spotify est envoyée/);
  const tom = env.DB.raw.prepare("SELECT u.id, s.status, s.spotify_account_email, s.spotify_account_name FROM users u JOIN music_sources s ON s.user_id = u.id WHERE u.email = 'tom@mail.fr'").get();
  assert.deepEqual([tom.status, tom.spotify_account_email, tom.spotify_account_name], ["pending_allowlist", "tom@mail.fr", "Tom"]);
  assert.ok(notes(env).some((n) => n.kind === "spotify_request" && n.user_id === tom.id && n.payload.account_email === "tom@mail.fr"));
  assert.ok(notes(env).some((n) => n.kind === "member_joined" && n.payload.spotify_requested === true));
  const sp = (await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" })).data;
  assert.deepEqual([sp.used, sp.requests.length], [1, 1]);
  // Correction de l'adresse de connexion : la demande Spotify qui la reprenait suit
  await invitationPage(env, token, { method: "POST", form: { action: "correct", email: "tom@gmail.com" } });
  assert.equal(env.DB.raw.prepare("SELECT spotify_account_email FROM music_sources WHERE user_id = ?").get(tom.id).spotify_account_email, "tom@gmail.com");
  assert.ok(notes(env).some((n) => n.kind === "spotify_request" && n.payload.account_email === "tom@gmail.com"));
  // Places pleines : plus de choix Spotify ; Spotify envoyé quand même (page ouverte avant) : message, rien de créé
  const token2 = await link("Zoé");
  assert.doesNotMatch((await invitationPage(env, token2)).html, /value="spotify"/);
  assert.match((await invitationPage(env, token2, { method: "POST", form: { email: "zoe@mail.fr", source: "spotify" } })).html, /places Spotify sont prises/);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'zoe@mail.fr'").get().n, 0);
  // Ancien membre Spotify dont le compte attend d'être retiré chez Spotify : accès rouvert, sans
  // retrait ni nouvel ajout, même quand les places sont pleines
  env.DB.raw.exec("INSERT INTO spotify_removals (account_name, account_email, member_name, reason, created_at) VALUES ('Zoé', 'zoe.s@mail.fr', 'Zoé', 'deleted', '2026-10-20T00:00:00+00:00')");
  env.SPOTIFY_MAX_USERS = "2";
  const back = await invitationPage(env, token2, { method: "POST", form: { email: "zoe@mail.fr", source: "spotify", spotify_email: "zoe.s@mail.fr" } });
  assert.match(back.html, /Connecter Spotify/);
  const zoe = env.DB.raw.prepare("SELECT u.id, s.status FROM users u JOIN music_sources s ON s.user_id = u.id WHERE u.email = 'zoe@mail.fr'").get();
  assert.equal(zoe.status, "ready_to_connect");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM spotify_removals").get().n, 0);
  // Compte Spotify déjà pris : formulaire à nouveau (choix gardé), rien de créé
  env.SPOTIFY_MAX_USERS = "5";
  const token3 = await link("Max");
  const refused = await invitationPage(env, token3, { method: "POST", form: { email: "max@mail.fr", source: "spotify", spotify_email: "Tom@Gmail.com" } });
  assert.match(refused.html, /déjà utilisé/);
  assert.match(refused.html, /value="spotify" id="src-spotify" checked/);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'max@mail.fr'").get().n, 0);
  // Nom facultatif dans la demande faite depuis le site : prénom à défaut
  const deezerOnly = await invitationPage(env, token3, { method: "POST", form: { email: "max@mail.fr" } });
  assert.match(deezerOnly.html, /C&#39;est fait|C'est fait/);
  const r = await call(env, "max@mail.fr", spotifyRequest.onRequestPost, { method: "POST", path: "/api/me/source/spotify/request", body: { account_email: "max.s@mail.fr" } });
  assert.equal(r.data.source.spotify_account_name, "Max");
});

test("lien d'invitation : expiration, nouveau lien (l'ancien ne marche plus), suppression", async () => {
  const env = setup();
  const created = await call(env, "c@test.fr", adminInvitations.onRequestPost, { method: "POST", path: "/api/admin/invitations", body: { first_name: "Inès" } });
  const old = new URL(created.data.link).pathname.split("/").pop();
  const id = created.data.invitation.id;
  const renewed = await call(env, "c@test.fr", adminRenew.onRequestPost, { method: "POST", path: `/api/admin/invitations/${id}/renew`, params: { id } });
  const fresh = new URL(renewed.data.link).pathname.split("/").pop();
  assert.notEqual(fresh, old);
  assert.equal((await invitationPage(env, old)).status, 410);
  assert.equal((await invitationPage(env, fresh)).status, 200);
  env.DB.raw.exec("UPDATE invitations SET expires_at = '2020-01-01T00:00:00+00:00'");
  assert.equal((await invitationPage(env, fresh)).status, 410);
  assert.equal((await call(env, "c@test.fr", adminInvitations.onRequestGet, { path: "/api/admin/invitations" })).data[0].expired, true);
  const del = await call(env, "c@test.fr", adminInvitation.onRequestDelete, { method: "DELETE", path: `/api/admin/invitations/${id}`, params: { id } });
  assert.equal(del.data.deleted, true);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM invitations").get().n, 0);
});

test("relais du calcul : demande de plus de 15 min sans résultat, une fois par 15 min, jamais pour un autre membre", async () => {
  const env = setup();
  const dispatched = [];
  env.GITHUB_ACTIONS_TOKEN = "jeton-github";
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.github.com/")) {
      if (String(url).includes("/weekly.yml/")) dispatched.push(JSON.parse(init.body).inputs.member);  // pas notify.yml
      return new Response(null, { status: 204 });
    }
    return before(url, init);
  };
  try {
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    env.DB.raw.exec(`INSERT INTO music_sources (user_id, provider, provider_user_id, status, sync_requested_at, last_sync_at) VALUES
      ('u_aaaaaaaa', 'spotify', 'sa', 'connected', '${ago(20)}', '${ago(60)}'),
      ('u_bbbbbbbb', 'deezer', '222', 'connected', '${ago(5)}', '${ago(60)}')`);
    await call(env, "a@test.fr", getMe);
    assert.deepEqual(dispatched, ["u_aaaaaaaa"]);
    await call(env, "a@test.fr", getMe);  // moins de 15 min après le relais : rien
    assert.deepEqual(dispatched, ["u_aaaaaaaa"]);
    await call(env, "b@test.fr", getMe);  // demande de 5 min : rien
    assert.deepEqual(dispatched, ["u_aaaaaaaa"]);
    // Relais de plus de 15 min, toujours sans résultat : nouveau relais
    env.DB.raw.exec(`UPDATE music_sources SET sync_relayed_at = '${ago(16)}' WHERE user_id = 'u_aaaaaaaa'`);
    await call(env, "a@test.fr", getMe);
    assert.deepEqual(dispatched, ["u_aaaaaaaa", "u_aaaaaaaa"]);
    // Calcul abouti (réussi ou en erreur) après la demande : plus de relais
    env.DB.raw.exec(`UPDATE music_sources SET last_sync_at = '${ago(1)}', sync_relayed_at = '${ago(30)}' WHERE user_id = 'u_aaaaaaaa'`);
    await call(env, "a@test.fr", getMe);
    assert.equal(dispatched.length, 2);
    // Tâche arrêtée avant la fin : 3 relais au plus pour une même demande
    env.DB.raw.exec(`UPDATE music_sources SET last_sync_at = '${ago(60)}', sync_relayed_at = '${ago(16)}', sync_relay_count = 3 WHERE user_id = 'u_aaaaaaaa'`);
    await call(env, "a@test.fr", getMe);
    assert.equal(dispatched.length, 2);
    // Nouvelle demande : compteur remis à 1
    env.DB.raw.exec(`UPDATE music_sources SET sync_requested_at = '${ago(16)}', sync_relayed_at = '${ago(20)}' WHERE user_id = 'u_aaaaaaaa'`);
    await call(env, "a@test.fr", getMe);
    assert.equal(dispatched.length, 3);
    assert.equal(env.DB.raw.prepare("SELECT sync_relay_count AS n FROM music_sources WHERE user_id = 'u_aaaaaaaa'").get().n, 1);
    // Membre suspendu : jamais
    env.DB.raw.exec(`UPDATE music_sources SET last_sync_at = '${ago(60)}' WHERE user_id = 'u_aaaaaaaa'`);
    env.DB.raw.exec("UPDATE users SET status = 'suspended' WHERE id = 'u_aaaaaaaa'");
    await call(env, "a@test.fr", getMe);
    assert.equal(dispatched.length, 3);
  } finally {
    globalThis.fetch = before;
  }
});

test("relais du calcul : lundi matin, échec du lancement, migration absente", async () => {
  const env = setup();
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  env.DB.raw.exec(`INSERT INTO music_sources (user_id, provider, provider_user_id, status, sync_requested_at, last_sync_at)
    VALUES ('u_aaaaaaaa', 'deezer', '111', 'connected', '${ago(20)}', '${ago(60)}')`);
  const user = env.DB.raw.prepare("SELECT * FROM users WHERE id = 'u_aaaaaaaa'").get();
  const { member } = await import("../functions/_lib/me.js");
  // Lundi 6 h UTC : pas de relais (traitement hebdomadaire en attente)
  assert.equal(await member(env, user).claimSyncRelay(new Date("2026-10-12T06:00:00Z")), false);
  assert.equal(await member(env, user).claimSyncRelay(new Date("2026-10-12T09:30:00Z")), true);
  // Lancement GitHub refusé : la page répond normalement
  env.DB.raw.exec("UPDATE music_sources SET sync_relayed_at = NULL, sync_relay_count = 0 WHERE user_id = 'u_aaaaaaaa'");
  env.GITHUB_ACTIONS_TOKEN = "jeton-github";
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith("https://api.github.com/")
    ? new Response("{}", { status: 500 }) : before(url, init));
  try {
    assert.equal((await call(env, "a@test.fr", getMe)).status, 200);
  } finally {
    globalThis.fetch = before;
  }
  // Migration 0007 non appliquée : la page répond normalement
  env.DB.raw.exec("ALTER TABLE music_sources DROP COLUMN sync_relay_count; ALTER TABLE music_sources DROP COLUMN sync_relayed_at");
  assert.equal((await call(env, "a@test.fr", getMe)).status, 200);
});

test("fiches Reels vues : par membre, sans doublon, contrôle des identifiants, vieilles lignes effacées", async () => {
  const env = setup();
  const post = (email, body) => call(env, email, seenRoute.onRequestPost, { method: "POST", path: "/api/me/seen", body });
  let r = await post("a@test.fr", { ids: ["aaaaaa111111", "cccccc333333", "aaaaaa111111"], user_id: "u_bbbbbbbb" });
  assert.equal(r.status, 200);
  assert.deepEqual([...r.data].sort(), ["aaaaaa111111", "cccccc333333"]);
  r = await post("a@test.fr", { ids: ["aaaaaa111111"] });  // déjà vue : aucune erreur, pas de doublon
  assert.equal(r.data.length, 2);
  assert.deepEqual((await call(env, "b@test.fr", seenRoute.onRequestGet, { path: "/api/me/seen" })).data, []);
  assert.equal((await post("a@test.fr", {})).status, 400);
  assert.equal((await post("a@test.fr", { ids: [{ id: "aaaaaa111111" }] })).status, 400);
  assert.deepEqual((await call(env, "b@test.fr", seenRoute.onRequestPost, { method: "POST", body: { ids: ["ffffff666666"] } })).data, ["ffffff666666"]);
  for (const ids of [[], ["../x"], "aaaaaa111111", Array.from({ length: 51 }, (_, i) => `aaaaaa${String(i).padStart(6, "0")}`)]) {
    assert.equal((await post("a@test.fr", { ids })).status, 400);
  }
  env.DB.raw.exec("INSERT INTO seen_cards (user_id, concert_id, seen_at) VALUES ('u_aaaaaaaa', 'dddddd444444', '2024-01-01T00:00:00+00:00')");
  r = await post("a@test.fr", { ids: ["eeeeee555555"] });
  assert.deepEqual([...r.data].sort(), ["aaaaaa111111", "cccccc333333", "eeeeee555555"]);
});

test("newsletter : réglage dans Mon compte, désabonnement par le lien sans connexion", async () => {
  const env = setup();
  assert.equal((await call(env, "a@test.fr", getMe)).data.newsletter, true);           // abonné par défaut
  let r = await call(env, "a@test.fr", meRoute.onRequestPatch, { method: "PATCH", body: { newsletter: false } });
  assert.equal(r.data.newsletter, false);
  assert.equal((await call(env, "a@test.fr", meRoute.onRequestPatch, { method: "PATCH", body: { newsletter: "non" } })).status, 400);
  await call(env, "a@test.fr", meRoute.onRequestPatch, { method: "PATCH", body: { newsletter: true } });
  // Lien de l'e-mail : la page ne désabonne pas, le bouton (ou la messagerie, en POST) oui
  const token = "jeton-personnel-de-test-0123456789";
  env.DB.raw.exec(`UPDATE users SET newsletter_token = '${token}' WHERE id = 'u_aaaaaaaa'`);
  const nl = () => env.DB.raw.prepare("SELECT newsletter FROM users WHERE id = 'u_aaaaaaaa'").get().newsletter;
  const get = await unsubscribeRoute.onRequestGet({ env, params: { token } });
  assert.equal(get.status, 200);
  assert.equal(nl(), 1);
  const post = await unsubscribeRoute.onRequestPost({ env, params: { token } });
  assert.equal(post.status, 200);
  assert.equal(nl(), 0);
  assert.equal(env.DB.raw.prepare("SELECT newsletter FROM users WHERE id = 'u_bbbbbbbb'").get().newsletter, 1);  // B intact
  for (const bad of ["inconnu-mais-assez-long-000000", "court", "'; DROP TABLE users; --"]) {
    assert.equal((await unsubscribeRoute.onRequestPost({ env, params: { token: bad } })).status, 404);
  }
  // Migration 0008 pas encore appliquée : profil affiché sans le réglage
  env.DB.raw.exec("DROP INDEX users_newsletter_token; ALTER TABLE users DROP COLUMN newsletter_sent_at; ALTER TABLE users DROP COLUMN newsletter_token; ALTER TABLE users DROP COLUMN newsletter");
  const me = await call(env, "a@test.fr", getMe);
  assert.equal(me.status, 200);
  assert.equal(me.data.newsletter, null);
});

test("★ visibles par les membres par défaut ; masqués au choix", async () => {
  const env = setup();
  // Nouveau membre invité par l'admin : réglage « visibles » d'emblée
  const r = await call(env, "c@test.fr", adminMembers.onRequestPost, {
    method: "POST", path: "/api/admin/members", body: { email: "nouveau@test.fr", first_name: "Nina" } });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  assert.equal(env.DB.raw.prepare("SELECT default_visibility AS v FROM users WHERE email = 'nouveau@test.fr'").get().v, "members");
  // Membre au réglage « visibles » : ★ partagé sans rien préciser ; « masqué » si demandé
  env.DB.raw.exec("UPDATE users SET default_visibility = 'members' WHERE id = 'u_aaaaaaaa'");
  await call(env, "a@test.fr", starRoute.onRequestPut, { method: "PUT", params: { concert: "eeeeee555555" }, body: { label: "x" } });
  await call(env, "a@test.fr", starRoute.onRequestPut, { method: "PUT", params: { concert: "ffffff666666" }, body: { label: "y", visibility: "private" } });
  const vis = (c) => env.DB.raw.prepare("SELECT visibility AS v FROM stars WHERE user_id = 'u_aaaaaaaa' AND concert_id = ?").get(c).v;
  assert.equal(vis("eeeeee555555"), "members");
  assert.equal(vis("ffffff666666"), "private");
  const seen = await call(env, "b@test.fr", communityRoute.onRequestGet, { path: "/api/community/stars" });
  assert.deepEqual(seen.data.map((s) => s.concert_id).filter((c) => ["eeeeee555555", "ffffff666666"].includes(c)), ["eeeeee555555"]);
});

test("concerts retirés : par membre, ★ effacée, remise, contrôles, lignes passées effacées, table absente", async () => {
  const env = setup();
  const put = (email, concert, body) => call(env, email, removedRoute.onRequestPut, { method: "PUT", params: { concert }, body });
  const body = { label: "2099-05-01 · Artiste A · La Cigale", date: "2099-05-01", venue: "La Cigale", title: "Artiste A",
    urls: ["https://billets.test/a", "javascript:alert(1)"], user_id: "u_bbbbbbbb" };
  // A retire son concert mis de côté : la ★ est effacée dans le même lot
  let r = await put("a@test.fr", "aaaaaa111111", body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.stars, []);
  assert.equal(r.data.removed.length, 1);
  assert.deepEqual(r.data.removed[0].urls, ["https://billets.test/a"]);  // adresse non http écartée
  assert.equal(r.data.removed[0].concert_date, "2099-05-01");
  // B ne voit rien de A ; sa ★ reste
  assert.deepEqual((await call(env, "b@test.fr", getRemoved, { path: "/api/me/removed" })).data, []);
  assert.equal((await call(env, "b@test.fr", getStars)).data.length, 1);
  // Même concert retiré deux fois : une seule ligne
  r = await put("a@test.fr", "aaaaaa111111", body);
  assert.equal(r.data.removed.length, 1);
  // Contrôles
  for (const [concert, b] of [["../x", body], ["aaaaaa111111", { ...body, date: "demain" }], ["aaaaaa111111", { ...body, label: " " }],
    ["aaaaaa111111", { ...body, urls: "https://x.test" }], ["aaaaaa111111", { ...body, urls: Array(6).fill("https://x.test") }]]) {
    assert.equal((await put("a@test.fr", concert, b)).status, 400, JSON.stringify(b));
  }
  // Remise par B d'un concert de A : sans effet chez A
  await call(env, "b@test.fr", removedRoute.onRequestDelete, { method: "DELETE", params: { concert: "aaaaaa111111" } });
  assert.equal((await call(env, "a@test.fr", getRemoved)).data.length, 1);
  r = await call(env, "a@test.fr", removedRoute.onRequestDelete, { method: "DELETE", params: { concert: "aaaaaa111111" } });
  assert.deepEqual(r.data, []);
  // Retrait passé effacé au retrait suivant
  env.DB.raw.exec("INSERT INTO removed_concerts (user_id, concert_id, concert_date, label, removed_at) VALUES ('u_aaaaaaaa', 'dddddd444444', '2024-01-01', 'vieux', 'x')");
  r = await put("a@test.fr", "eeeeee555555", body);
  assert.deepEqual(r.data.removed.map((x) => x.concert_id), ["eeeeee555555"]);
  // Plafond atteint avec des lignes passées seulement : elles sont effacées, le retrait passe
  env.DB.raw.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) " +
    "INSERT INTO removed_concerts (user_id, concert_id, concert_date, label, removed_at) " +
    "SELECT 'u_aaaaaaaa', printf('old%09d', i), '2024-01-01', 'vieux', 'x' FROM n");
  r = await put("a@test.fr", "ffffff666666", body);
  assert.equal(r.status, 200);
  assert.equal(r.data.removed.length, 2);
  // Migration 0010 non appliquée : liste vide, retrait refusé proprement
  env.DB.raw.exec("DROP TABLE removed_concerts");
  assert.deepEqual((await call(env, "a@test.fr", getRemoved)).data, []);
  r = await put("a@test.fr", "aaaaaa111111", body);
  assert.equal(r.status, 503);
  assert.equal(r.data.code, "removed_unavailable");
});

// --- Version 1.9.0 : Spotify préparé à l'invitation, notifications, signalements, quota ------

const queued = (env) => env.DB.raw.prepare("SELECT kind, user_id, to_admin, payload FROM notifications ORDER BY id").all()
  .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

test("invitation avec compte Spotify : place prise, source prête à connecter, retrait si le lien est supprimé", async () => {
  const env = spotifyEnv();
  const post = (body) => call(env, "c@test.fr", adminInvitations.onRequestPost, { method: "POST", path: "/api/admin/invitations", body });
  assert.equal((await post({ first_name: "Hugo", spotify_email: "pas-un-mail" })).data.code, "bad_email");
  const created = await post({ first_name: "Hugo", spotify_email: " Hugo.S@Mail.fr " });
  assert.equal(created.status, 201);
  assert.equal(created.data.invitation.spotify_account_email, "hugo.s@mail.fr");
  assert.equal(created.data.invitation.spotify_account_name, "Hugo");     // prénom à défaut de nom
  assert.match(created.data.spotify_dashboard_url, /developer\.spotify\.com\/dashboard\/client-test\/users/);
  assert.equal((await post({ first_name: "Autre", spotify_email: "hugo.s@mail.fr" })).data.code, "taken");
  const sp = (await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" })).data;
  assert.deepEqual([sp.used, sp.invitations.length], [1, 1]);
  // Inscription : source Spotify prête, sans formulaire ni attente
  const token = new URL(created.data.link).pathname.split("/").pop();
  // Compte préparé : pas de choix de source sur la page
  assert.doesNotMatch((await invitationPage(env, token)).html, /value="spotify"/);
  const done = await invitationPage(env, token, { method: "POST", form: { email: "hugo@mail.fr", source: "deezer" } });
  assert.match(done.html, /Connecter Spotify/);
  const src = env.DB.raw.prepare("SELECT s.status, s.spotify_account_email, s.spotify_allowlisted_at FROM music_sources s JOIN users u ON u.id = s.user_id WHERE u.email = 'hugo@mail.fr'").get();
  assert.deepEqual([src.status, src.spotify_account_email, Boolean(src.spotify_allowlisted_at)], ["ready_to_connect", "hugo.s@mail.fr", true]);
  assert.equal((await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" })).data.used, 1);  // toujours une place
  assert.ok(queued(env).some((n) => n.kind === "member_joined" && n.to_admin === 1 && n.payload.spotify === true));
  const me = await call(env, "hugo@mail.fr", getMe);
  assert.equal(me.data.source.status, "ready_to_connect");
  // Lien préparé puis supprimé : compte à retirer chez Spotify
  const other = await post({ first_name: "Inès", spotify_email: "ines@mail.fr" });
  const del = await call(env, "c@test.fr", adminInvitation.onRequestDelete, { method: "DELETE", path: `/api/admin/invitations/${other.data.invitation.id}`, params: { id: other.data.invitation.id } });
  assert.equal(del.data.spotify_removal, true);
  const after = (await call(env, "c@test.fr", adminSpotify.onRequestGet, { path: "/api/admin/spotify" })).data;
  assert.deepEqual([after.removals.length, after.removals[0].reason, after.invitations.length], [1, "deleted", 0]);
});

test("invitation par e-mail avec compte Spotify ; places Spotify pleines", async () => {
  const env = { ...spotifyEnv(), SPOTIFY_MAX_USERS: "1" };
  const invite = (email, sp) => call(env, "c@test.fr", adminMembers.onRequestPost, {
    method: "POST", path: "/api/admin/members", body: { email, first_name: "Jo", spotify_email: sp } });
  const r = await invite("jo@test.fr", "jo.spotify@test.fr");
  assert.equal(r.status, 201);
  assert.equal(env.DB.raw.prepare("SELECT status FROM music_sources WHERE spotify_account_email = 'jo.spotify@test.fr'").get().status, "ready_to_connect");
  assert.equal((await invite("kim@test.fr", "kim.spotify@test.fr")).data.code, "spotify_full");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'kim@test.fr'").get().n, 0);  // rien de créé
});

test("notifications : connexion d'un membre une fois par jour, jamais l'admin ; demande Spotify ; accès ouvert", async () => {
  const env = spotifyEnv();
  await call(env, "a@test.fr", getMe, { jwt: await token({ email: "a@test.fr", iat: 1791800000 }) });
  await call(env, "a@test.fr", getMe, { jwt: await token({ email: "a@test.fr", iat: 1791800000 }) });  // même session
  await call(env, "a@test.fr", getMe, { jwt: await token({ email: "a@test.fr", iat: 1791800500 }) });  // nouvelle session
  await call(env, "c@test.fr", getMe, { jwt: await token({ email: "c@test.fr", iat: 1791800000 }) });  // admin
  const logins = queued(env).filter((n) => n.kind === "member_login");
  assert.deepEqual(logins.map((n) => [n.user_id, n.payload.first]), [["u_aaaaaaaa", true]]);  // un message par jour
  await call(env, "a@test.fr", getMe, { jwt: await token({ email: "a@test.fr", iat: 1791801000 }) });  // même jour
  assert.equal(queued(env).filter((n) => n.kind === "member_login").length, 1);
  // Demande de place Spotify : l'admin est prévenu (sans jeton ni identifiant Spotify)
  env.DB.raw.exec("INSERT INTO users (id, email, first_name, status, invited_at) VALUES ('u_dddddddd', 'd@test.fr', 'Dora', 'onboarding', 'x')");
  await call(env, "d@test.fr", spotifyRequest.onRequestPost, { method: "POST", body: { account_email: "dora@spotify.fr", account_name: "Dora D." } });
  const request = queued(env).find((n) => n.kind === "spotify_request");
  assert.deepEqual([request.user_id, request.payload.account_email], ["u_dddddddd", "dora@spotify.fr"]);
  await call(env, "c@test.fr", adminAllowlisted.onRequestPost, { method: "POST", path: "/api/admin/spotify/u_dddddddd/allowlisted", params: { user: "u_dddddddd" } });
  assert.ok(queued(env).some((n) => n.kind === "spotify_ready" && n.user_id === "u_dddddddd" && n.to_admin === 0));
});

test("J'ai un problème : enregistré avec le contexte, 5 par jour, visible et résolu par l'admin seulement", async () => {
  const env = setup();
  const report = (body, email = "a@test.fr") => call(env, email, problemRoute.onRequestPost, { method: "POST", path: "/api/me/problem", body });
  const r = await report({ message: "  Je ne vois aucun concert  ", context: { ecran: "calendar", artistes: 0, "<script>": "x", objet: { a: 1 } } });
  assert.equal(r.status, 201);
  const row = env.DB.raw.prepare("SELECT user_id, message, context FROM problem_reports").get();
  assert.equal(row.message, "Je ne vois aucun concert");
  assert.deepEqual(JSON.parse(row.context), { ecran: "calendar", artistes: "0" });   // clés et valeurs contrôlées
  assert.ok(queued(env).some((n) => n.kind === "problem_report" && n.to_admin === 1 && n.payload.message === "Je ne vois aucun concert"));
  for (let i = 0; i < 4; i++) assert.equal((await report({})).status, 201);
  assert.equal((await report({})).data.code, "too_many");
  assert.equal((await report({}, "b@test.fr")).status, 201);                            // autre membre : à part
  assert.equal((await call(env, "a@test.fr", adminProblems.onRequestGet, { path: "/api/admin/problems" })).status, 403);
  const list = (await call(env, "c@test.fr", adminProblems.onRequestGet, { path: "/api/admin/problems" })).data;
  assert.equal(list.length, 6);
  assert.equal(list.find((p) => p.message).display_name, "Alice");
  const id = list[0].id;
  const resolve = () => call(env, "c@test.fr", adminProblemResolved.onRequestPost, { method: "POST", path: `/api/admin/problems/${id}/resolved`, params: { id: String(id) } });
  assert.equal((await resolve()).data.resolved, true);
  assert.equal((await resolve()).status, 404);
  const again = (await call(env, "c@test.fr", adminProblems.onRequestGet, { path: "/api/admin/problems" })).data;
  assert.ok(again.at(-1).resolved_at);                                                     // résolus en dernier
});

test("quota Spotify : Synchroniser maintenant sans effet pendant la pause ; essai automatique visible et relayé", async () => {
  const env = setup();
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const later = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  env.DB.raw.exec(`UPDATE users SET status = 'error' WHERE id = 'u_aaaaaaaa';
    INSERT INTO music_sources (user_id, provider, provider_user_id, status, last_sync_status, last_sync_at, sync_requested_at, retry_at)
      VALUES ('u_aaaaaaaa', 'spotify', 'sa', 'connected', 'quota', '${ago(60)}', '${ago(120)}', '${later}');
    INSERT INTO service_pauses (service, until, reason, created_at) VALUES ('spotify', '${later}', 'quota', '${ago(60)}')`);
  const sync = await call(env, "a@test.fr", syncRoute.onRequestPost, { method: "POST" });
  assert.deepEqual([sync.status, sync.data.code], [409, "spotify_paused"]);
  const me = (await call(env, "a@test.fr", getMe)).data;
  assert.equal(me.source.retry_at, later);
  assert.equal(me.spotify.paused_until, later);
  // Essai arrivé à échéance : relancé à l'ouverture du site, une fois par 15 minutes
  const dispatched = [];
  env.GITHUB_ACTIONS_TOKEN = "jeton-github";
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.github.com/")) {
      if (String(url).includes("/weekly.yml/")) dispatched.push(JSON.parse(init.body).inputs.member);
      return new Response(null, { status: 204 });
    }
    return before(url, init);
  };
  try {
    env.DB.raw.exec(`UPDATE music_sources SET retry_at = '${ago(5)}'`);
    await call(env, "a@test.fr", getMe);
    await call(env, "a@test.fr", getMe);
    assert.deepEqual(dispatched, ["u_aaaaaaaa"]);
  } finally {
    globalThis.fetch = before;
  }
});

test("salles (1.12.0) : vérification automatique lancée à la proposition avec page programme, relance et retrait par l'admin", async () => {
  const env = setup();
  const dispatched = [];
  let refuse = false;
  env.GITHUB_ACTIONS_TOKEN = "jeton-github";
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.github.com/")) {
      if (String(url).includes("/venue-check.yml/")) dispatched.push(JSON.parse(init.body).inputs.venue);
      return new Response(null, { status: refuse ? 403 : 204 });
    }
    return before(url, init);
  };
  const row = (id) => env.DB.raw.prepare("SELECT status, check_status, check_summary, auto_approved FROM venues WHERE id = ?").get(id);
  const propose = (body) => call(env, "a@test.fr", proposalsRoute.onRequestPost, { method: "POST", path: "/api/venues/proposals", body });
  const check = (id) => call(env, "c@test.fr", adminCheck.onRequestPost, { method: "POST", path: `/api/admin/venues/${id}/check`, params: { id } });
  try {
    // Avec page programme : vérification demandée et workflow lancé ; le membre voit « en cours »
    const ok = await propose({ name: "Bal Chavaux", agenda_url: "https://balchavaux.fr/agenda" });
    assert.equal(ok.status, 201);
    assert.deepEqual(dispatched, ["bal-chavaux"]);
    assert.equal(ok.data[0].check_status, "running");
    // Sans page programme : rien de lancé, l'admin décide
    await propose({ name: "Salle Sans Site" });
    assert.deepEqual(dispatched, ["bal-chavaux"]);
    assert.equal(row("salle-sans-site").check_status, null);
    // Lancement refusé par GitHub : la salle reste à l'admin, avec la raison
    refuse = true;
    await propose({ name: "Bus Palladium", agenda_url: "https://www.buspalladium.club/" });
    assert.equal(row("bus-palladium").check_status, "failed");
    assert.match(JSON.parse(row("bus-palladium").check_summary).reasons[0], /non lancée/);
    const pending = (await call(env, "c@test.fr", adminVenues.onRequestGet, { path: "/api/admin/venues?status=pending" })).data;
    assert.match(pending.find((v) => v.id === "bus-palladium").check_summary.reasons[0], /non lancée/);
    // Relance par l'admin : seulement pour une salle en attente avec page programme
    refuse = false;
    const again = await check("bus-palladium");
    assert.deepEqual([again.data.check_status, again.data.run.done], ["running", true]);
    assert.deepEqual(dispatched, ["bal-chavaux", "bus-palladium", "bus-palladium"]);   // essai refusé, puis relance
    assert.equal((await check("salle-sans-site")).data.code, "not_checkable");
    assert.equal((await call(env, "a@test.fr", adminCheck.onRequestPost, { method: "POST", path: "/api/admin/venues/bus-palladium/check", params: { id: "bus-palladium" } })).status, 403);
    // Salle ajoutée automatiquement (tâche venue-check) : visible comme telle, retrait possible
    env.DB.raw.exec("UPDATE venues SET status = 'approved', auto_approved = 1, check_status = 'ok' WHERE id = 'bal-chavaux'");
    const mine = (await call(env, "a@test.fr", proposalsRoute.onRequestGet, { path: "/api/venues/proposals" })).data;
    assert.equal(mine.find((v) => v.id === "bal-chavaux").auto_approved, 1);
    const approved = (await call(env, "c@test.fr", adminVenues.onRequestGet, { path: "/api/admin/venues?status=approved" })).data;
    assert.equal(approved.find((v) => v.id === "bal-chavaux").auto_approved, true);
    assert.equal((await check("bal-chavaux")).data.code, "not_checkable");
    const removed = await call(env, "c@test.fr", adminReject.onRequestPost, { method: "POST", path: "/api/admin/venues/bal-chavaux/reject", params: { id: "bal-chavaux" } });
    assert.equal(removed.data.status, "rejected");
    // Une salle approuvée par l'admin ne se retire pas par ce chemin ; réapprouvée, elle n'est plus « automatique »
    env.DB.raw.exec("INSERT INTO venues (id, name, status) VALUES ('olympia', 'Olympia', 'approved')");
    assert.equal((await call(env, "c@test.fr", adminReject.onRequestPost, { method: "POST", path: "/api/admin/venues/olympia/reject", params: { id: "olympia" } })).data.code, "not_pending");
    await call(env, "c@test.fr", adminApprove.onRequestPost, { method: "POST", path: "/api/admin/venues/bal-chavaux/approve", params: { id: "bal-chavaux" } });
    assert.deepEqual([row("bal-chavaux").status, row("bal-chavaux").auto_approved], ["approved", 0]);
  } finally {
    globalThis.fetch = before;
  }
});

// --- Lien d'invité (version 1.15.0) -------------------------------------------------------

// Toutes les routes de lecture /api : sans jeton Access, 401 sans que la route soit appelée et
// sans aucune donnée de membre dans la réponse
test("sans session : aucune route /api ne renvoie une donnée de membre", async () => {
  const env = setup();
  env.BUCKET.objects["users/u_aaaaaaaa/meta.json"] = '{"counts":{"known":1}}';
  const routes = {
    "/api/me": getMe, "/api/me/stars": getStars, "/api/me/prefs": getPrefs, "/api/me/artists": getArtists,
    "/api/me/concerts": getConcerts, "/api/me/removed": getRemoved, "/api/me/seen": seenRoute.onRequestGet,
    "/api/me/month-seen": monthSeenRoute.onRequestGet, "/api/community/stars": communityRoute.onRequestGet,
    "/api/venues": venuesRoute.onRequestGet, "/api/venues/proposals": proposalsRoute.onRequestGet,
    "/api/admin/members": adminMembers.onRequestGet, "/api/admin/guest-link": guestLinkRoute.onRequestGet,
    "/api/admin/invitations": adminInvitations.onRequestGet, "/api/admin/problems": adminProblems.onRequestGet,
  };
  const secrets = ["a@test.fr", "b@test.fr", "c@test.fr", "u_aaaaaaaa", "Artiste A", "Artiste B", "aaaaaa111111", "Concert de A"];
  for (const [path, route] of Object.entries(routes)) {
    let reached = false;
    for (const jwt of ["", "abc.def.ghi"]) {
      const r = await call(env, "a@test.fr", (ctx) => { reached = true; return route(ctx); }, { path, jwt });
      assert.equal(r.status, 401, path);
      const text = JSON.stringify(r.data);
      for (const s of secrets) assert.ok(!text.includes(s), `${path} : ${s}`);
    }
    assert.equal(reached, false, path);
  }
});

// Site statique simulé (env.ASSETS) : page d'accueil, catalogue commun, scripts
function withAssets(env) {
  const files = {
    "/": '<!doctype html><html><head><title>Concerts</title></head><body><script src="app.js"></script></body></html>',
    "/data/events.json": '[{"id":"cccccc333333"}]', "/data/meta.json": "{}", "/app.js": "/* app */",
    "/data/share/aa.json": "[]",
  };
  env.ASSETS = { fetch: async (url) => {
    const p = new URL(url).pathname;
    const type = { js: "text/javascript", json: "application/json", css: "text/css" }[p.split(".").pop()] || "text/html";
    // Comme Pages sans 404.html : fichier absent, page d'accueil avec 200
    return p in files ? new Response(files[p], { headers: { "content-type": type } })
      : new Response(files["/"], { headers: { "content-type": "text/html" } });
  } };
  return env;
}

function guestSetup() {
  const env = withAssets(setup());
  const now = "2026-10-12T00:00:00+00:00";
  env.DB.raw.exec(`
    INSERT INTO stars (user_id, concert_id, label, created_at, updated_at) VALUES ('u_cccccccc', 'cccccc999999', 'Secret de C', '${now}', '${now}');
    INSERT INTO artist_prefs (user_id, artist_key, artist_name, hidden, updated_at) VALUES ('u_cccccccc', 'artiste masque', 'Artiste masqué', 1, '${now}');
    INSERT INTO venues (id, name, status) VALUES ('petit-bain', 'Petit Bain', 'approved');
    INSERT INTO venue_favorites (user_id, venue_id, added_at) VALUES ('u_cccccccc', 'petit-bain', '${now}');
  `);
  Object.assign(env.BUCKET.objects, {
    "users/u_cccccccc/artists.json": '{"9":{"name":"Artiste C"}}',
    "users/u_cccccccc/overlay.json": '{"cccccc333333":{"kind":"known"}}',
    "users/u_cccccccc/meta.json": '{"counts":{"known":1}}',
  });
  return env;
}

// Requête sur /visite/... : params.path comme Cloudflare Pages ([[path]] : segments non vides)
async function visit(env, path, method = "GET") {
  const request = new Request(`https://concerts.test${path}`, { method });
  const parts = path.replace(/^\/visite\/?/, "").split("/").filter(Boolean);
  const r = await visiteRoute.onRequest({ request, env, params: { path: parts } });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

const createLink = async (env) =>
  (await call(env, "c@test.fr", guestLinkRoute.onRequestPost, { method: "POST", path: "/api/admin/guest-link" })).data.link;

test("lien d'invité : créé par l'admin seulement, nouveau lien remplace l'ancien", async () => {
  const env = guestSetup();
  const member = await call(env, "a@test.fr", guestLinkRoute.onRequestPost, { method: "POST", path: "/api/admin/guest-link" });
  assert.deepEqual([member.status, member.data.code], [403, "not_admin"]);
  assert.equal((await call(env, "c@test.fr", guestLinkRoute.onRequestGet, { path: "/api/admin/guest-link" })).data.link, null);
  const first = await createLink(env);
  assert.match(first, /^https:\/\/concerts\.test\/visite\/[A-Za-z0-9_-]{40,60}\/$/);
  assert.equal((await call(env, "c@test.fr", guestLinkRoute.onRequestGet, { path: "/api/admin/guest-link" })).data.link, first);
  const path = new URL(first).pathname;
  assert.equal((await visit(env, `${path}api/guest`)).status, 200);
  const second = await createLink(env);
  assert.notEqual(second, first);
  assert.equal((await visit(env, `${path}api/guest`)).status, 404);
  assert.equal((await visit(env, `${new URL(second).pathname}api/guest`)).status, 200);
  await call(env, "c@test.fr", guestLinkRoute.onRequestDelete, { method: "DELETE", path: "/api/admin/guest-link" });
  assert.equal((await visit(env, `${new URL(second).pathname}api/guest`)).status, 404);
});

test("lien d'invité : univers de l'admin en lecture seule, sans ★, e-mail ni identifiant", async () => {
  const env = guestSetup();
  const base = new URL(await createLink(env)).pathname;
  const g = await visit(env, `${base}api/guest`);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get("referrer-policy"), "no-referrer");
  const data = JSON.parse(g.text);
  assert.deepEqual(Object.keys(data.artists), ["9"]);
  assert.deepEqual(Object.keys(data.concerts.overlay), ["cccccc333333"]);
  assert.deepEqual(data.prefs.hidden, ["Artiste masqué"]);
  assert.deepEqual(data.profile.favorite_venues, ["petit-bain"]);
  assert.deepEqual([data.profile.owner_name, data.profile.role, data.profile.email], ["Chloé", "guest", null]);
  for (const s of ["c@test.fr", "a@test.fr", "u_cccccccc", "u_aaaaaaaa", "cccccc999999", "Secret de C", "Artiste A", "aaaaaa111111"]) {
    assert.ok(!g.text.includes(s), s);
  }
  // Page d'accueil en mode invité ; catalogue commun et scripts du site
  assert.equal((await visit(env, base.replace(/\/$/, ""))).status, 302);
  const page = await visit(env, base);
  assert.ok(page.text.includes("window.GUEST_MODE = true") && page.text.includes('content="no-referrer"'));
  assert.equal((await visit(env, `${base}data/events.json`)).status, 200);
  assert.equal((await visit(env, `${base}app.js`)).status, 200);
  // Rien d'autre : routes membres, fichiers hors liste
  for (const p of ["api/me", "api/me/stars", "api/admin/members", "api/guest/x", "data/share/aa.json", "data/../app.js", "inconnu.js", "vendor/absent.css"]) {
    assert.equal((await visit(env, `${base}${p}`)).status, 404, p);
  }
  // Aucune écriture : 405 et base inchangée
  const count = () => env.DB.raw.prepare("SELECT (SELECT COUNT(*) FROM stars) + (SELECT COUNT(*) FROM artist_prefs) + " +
    "(SELECT COUNT(*) FROM venue_favorites) + (SELECT COUNT(*) FROM seen_cards) AS n").get().n;
  const before = count();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await visit(env, `${base}api/guest`, method)).status, 405, method);
  }
  assert.equal(count(), before);
});

test("lien d'invité : jeton inconnu, lien d'un membre non admin ou d'un admin suspendu refusés", async () => {
  const env = guestSetup();
  const forged = "x".repeat(43);
  for (const p of [`/visite/${forged}/api/guest`, `/visite/${forged}/`, "/visite/court/api/guest", "/visite/"]) {
    const r = await visit(env, p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes("Artiste") && !r.text.includes("GUEST_MODE"), p);
  }
  env.DB.raw.exec(`INSERT INTO guest_links (token, user_id, created_at) VALUES ('${"a".repeat(43)}', 'u_aaaaaaaa', '2026-10-12T00:00:00+00:00')`);
  assert.equal((await visit(env, `/visite/${"a".repeat(43)}/api/guest`)).status, 404);
  const link = await createLink(env);
  env.DB.raw.exec("UPDATE users SET status = 'suspended' WHERE id = 'u_cccccccc'");
  assert.equal((await visit(env, `${new URL(link).pathname}api/guest`)).status, 404);
});
