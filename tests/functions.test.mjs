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
    run: async () => db.prepare(sql).run(...args),
  });
  return { raw: db, prepare: (sql) => statement(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

function fakeR2(objects) {
  return {
    get: async (key) => (key in objects
      ? { text: async () => objects[key], body: new Response(objects[key]).body }
      : null),
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
globalThis.fetch = async (url, init) => (String(url) === `https://${TEAM}/cdn-cgi/access/certs`
  ? new Response(JSON.stringify({ keys: [jwk] }))
  : realFetch(url, init));

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
