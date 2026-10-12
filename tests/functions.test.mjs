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
globalThis.fetch = async (url, init) => {
  const u = String(url);
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
  "venue_favorites", "stars", "member_runs"];

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
  // Après un calcul en erreur, un nouvel essai est permis aussitôt
  assert.equal((await call(env, "b@test.fr", syncRoute.onRequestPost, { method: "POST" })).status, 200);
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
