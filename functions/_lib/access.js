// Vérification du jeton Cloudflare Access (en-tête Cf-Access-Jwt-Assertion).
//
// Signature RS256 contre les certificats publics de l'équipe Access
// (https://<équipe>.cloudflareaccess.com/cdn-cgi/access/certs), audience ACCESS_AUD (plusieurs
// valeurs possibles, séparées par des virgules), émetteur et dates de validité. Renvoie
// { email, iat } ; lève une HttpError 401 sinon.
//
// Variables : ACCESS_TEAM_DOMAIN (ex. « monequipe.cloudflareaccess.com »), ACCESS_AUD.
// Essais en local (wrangler pages dev) : DEV_ACCESS_EMAIL remplace le jeton, uniquement sur
// localhost ou 127.0.0.1.

import { HttpError } from "./http.js";

const CERTS_TTL = 3600 * 1000;
let certs = { team: null, keys: new Map(), fetched: 0 };

const b64urlBytes = (s) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function loadKeys(team) {
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`certificats Access indisponibles (HTTP ${r.status})`);
  const { keys = [] } = await r.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    map.set(jwk.kid, key);
  }
  certs = { team, keys: map, fetched: Date.now() };
}

async function keyFor(team, kid) {
  if (certs.team !== team || Date.now() - certs.fetched > CERTS_TTL) await loadKeys(team);
  // Clé inconnue : rotation des certificats côté Access, on relit une fois
  if (!certs.keys.has(kid) && Date.now() - certs.fetched > 60 * 1000) await loadKeys(team);
  return certs.keys.get(kid);
}

const teamDomain = (env) => String(env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");

export async function verifyAccess(request, env) {
  const host = new URL(request.url).hostname;
  if (env.DEV_ACCESS_EMAIL && (host === "localhost" || host === "127.0.0.1")) {
    // Essais en local : le cookie dev_email permet de se connecter comme un autre membre de test
    const cookie = (request.headers.get("cookie") || "").match(/(?:^|;\s*)dev_email=([^;]+)/);
    const email = cookie ? decodeURIComponent(cookie[1]) : env.DEV_ACCESS_EMAIL;
    return { email: String(email).toLowerCase(), iat: Number(env.DEV_ACCESS_IAT || 1) };
  }
  const team = teamDomain(env);
  const audiences = String(env.ACCESS_AUD || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!team || !audiences.length) throw new HttpError(503, "vérification Access non configurée", "access_config");

  const token = request.headers.get("cf-access-jwt-assertion");
  const parts = (token || "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "connexion requise", "no_token");
  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw new HttpError(401, "jeton illisible", "bad_token");
  }
  if (header.alg !== "RS256") throw new HttpError(401, "jeton refusé", "bad_token");

  let signature;
  try {
    signature = b64urlBytes(parts[2]);
  } catch {
    throw new HttpError(401, "jeton illisible", "bad_token");
  }
  const key = await keyFor(team, header.kid);
  const valid = key && await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new HttpError(401, "jeton refusé", "bad_signature");

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.some((a) => audiences.includes(a))) throw new HttpError(401, "jeton refusé", "bad_audience");
  if (payload.iss !== `https://${team}`) throw new HttpError(401, "jeton refusé", "bad_issuer");
  if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new HttpError(401, "connexion expirée", "expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new HttpError(401, "jeton refusé", "not_yet_valid");
  if (!payload.email) throw new HttpError(401, "jeton sans e-mail", "no_email");
  return { email: String(payload.email).toLowerCase(), iat: Number(payload.iat) || 0 };
}
