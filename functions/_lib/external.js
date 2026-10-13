// Services extérieurs appelés par les fonctions : liste Access des membres et révocation des
// sessions (API Cloudflare), lancement d'un calcul (GitHub Actions), profil public Deezer,
// autorisation Spotify d'un membre (OAuth).
//
// Variables : CF_ACCOUNT_ID, ACCESS_LIST_ID (liste Zero Trust « membres »), CF_ADMIN_API_TOKEN
// (secret : Zero Trust Edit, Access Organizations Edit), GITHUB_ACTIONS_TOKEN (secret : droit
// Actions du seul dépôt), GITHUB_REPO (« byTSY/Concerts » par défaut).
// Sans ces réglages (environnement d'essai), les opérations sont signalées comme non faites
// au lieu d'échouer : { done: false, reason }.

const CF_API = "https://api.cloudflare.com/client/v4";

async function cloudflare(env, method, path, body) {
  const r = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_ADMIN_API_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) {
    const msg = (data.errors || []).map((e) => e.message).join("; ") || `HTTP ${r.status}`;
    throw new Error(`Cloudflare : ${msg}`);
  }
  return data.result;
}

const accessReady = (env) => env.CF_ACCOUNT_ID && env.ACCESS_LIST_ID && env.CF_ADMIN_API_TOKEN;

// Liste Zero Trust « membres », utilisée par la règle Access du site
export async function accessListAdd(env, email) {
  if (!accessReady(env)) return { done: false, reason: "liste Access non configurée" };
  await cloudflare(env, "PATCH", `/gateway/lists/${env.ACCESS_LIST_ID}`, { append: [{ value: email }] });
  return { done: true };
}

export async function accessListRemove(env, email) {
  if (!accessReady(env)) return { done: false, reason: "liste Access non configurée" };
  await cloudflare(env, "PATCH", `/gateway/lists/${env.ACCESS_LIST_ID}`, { remove: [email] });
  return { done: true };
}

// Coupe toutes les sessions Access de l'adresse (le membre devra se reconnecter, et sera refusé)
export async function revokeSessions(env, email) {
  if (!env.CF_ACCOUNT_ID || !env.CF_ADMIN_API_TOKEN) return { done: false, reason: "clé Cloudflare non configurée" };
  await cloudflare(env, "POST", "/access/organizations/revoke_user", { email });
  return { done: true };
}

// Lance le calcul d'un membre (workflow « Mise à jour hebdomadaire », paramètre member) ;
// sans membre : traitement complet
export async function dispatchRun(env, memberId = "") {
  if (!env.GITHUB_ACTIONS_TOKEN) return { done: false, reason: "lancement GitHub non configuré" };
  const repo = env.GITHUB_REPO || "byTSY/Concerts";
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/weekly.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "concerts-paris",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { member: memberId } }),
  });
  if (r.status !== 204) throw new Error(`GitHub : lancement refusé (HTTP ${r.status})`);
  return { done: true };
}

// --- Deezer : profil public d'un membre -----------------------------------------------

// « 1836006062 », « https://www.deezer.com/fr/profile/1836006062 », lien court de partage
// (deezer.page.link, link.deezer.com) suivi jusqu'au profil
export async function deezerProfileId(input) {
  const text = String(input || "").trim();
  if (/^\d{1,15}$/.test(text)) return text;
  let url;
  try { url = new URL(text.startsWith("http") ? text : `https://${text}`); } catch { return null; }
  const fromPath = (u) => (u.pathname.match(/\/(?:profile|user)\/(\d{1,15})/) || [])[1] || null;
  if (/(^|\.)deezer\.com$/.test(url.hostname)) return fromPath(url);
  if (/^(deezer\.page\.link|link\.deezer\.com|dzr\.page\.link)$/.test(url.hostname)) {
    const r = await fetch(url, { redirect: "manual" });
    const location = r.headers.get("location");
    if (!location) return null;
    try { return fromPath(new URL(location)); } catch { return null; }
  }
  return null;
}

// Nom, photo et nombre d'artistes favoris ;
// { error: "not_found" | "private_profile" | "deezer_unavailable" }
export async function deezerProfile(id) {
  // null : Deezer ne répond pas (réseau, erreur serveur, quota dépassé)
  const get = async (path) => {
    try {
      const r = await fetch(`https://api.deezer.com${path}`);
      if (!r.ok) return null;
      const data = await r.json();
      return data?.error?.code === 4 ? null : data;
    } catch {
      return null;
    }
  };
  const user = await get(`/user/${id}`);
  if (!user) return { error: "deezer_unavailable" };
  if (user.error) return { error: user.error.code === 800 ? "not_found" : "deezer_unavailable" };
  if (!user.id) return { error: "not_found" };
  const favs = await get(`/user/${id}/artists?limit=1`);
  if (!favs) return { error: "deezer_unavailable" };
  if (favs.error) return { error: "private_profile" };
  return { id: String(user.id), name: user.name, picture: user.picture_medium || null, favorites: favs.total ?? (favs.data || []).length };
}

// --- Spotify : autorisation d'un membre (Authorization Code avec PKCE) --------------------
// Variables : SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET (secret, échange côté serveur).
// Aucun jeton n'est journalisé ni renvoyé au navigateur.

export const SPOTIFY_SCOPES =
  "user-library-read user-follow-read user-top-read playlist-read-private playlist-read-collaborative";

export const spotifyReady = (env) => Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);

// Page User Management de l'application dans le tableau de bord Spotify (format vérifié le
// 13 octobre 2026 : l'identifiant de l'application est son Client ID)
export const spotifyDashboardUrl = (env) => (env.SPOTIFY_CLIENT_ID
  ? `https://developer.spotify.com/dashboard/${encodeURIComponent(env.SPOTIFY_CLIENT_ID)}/users`
  : "https://developer.spotify.com/dashboard");

const urlSafe = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomToken(size = 32) {
  return urlSafe(crypto.getRandomValues(new Uint8Array(size)));
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return urlSafe(new Uint8Array(digest));
}

export async function spotifyAuthorizeUrl(env, { state, verifier, redirectUri }) {
  const q = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: await pkceChallenge(verifier),
    show_dialog: "true",  // le membre voit le compte Spotify utilisé et peut en changer
  });
  return `https://accounts.spotify.com/authorize?${q}`;
}

// Échange du code contre les jetons ; { error } si Spotify refuse (code expiré, déjà utilisé)
export async function spotifyExchange(env, { code, verifier, redirectUri }) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token || !data.refresh_token) {
    // Seul le code d'erreur Spotify est gardé (jamais le corps complet)
    throw new Error(`Spotify : échange refusé (HTTP ${r.status}${data.error ? `, ${String(data.error).slice(0, 40)}` : ""})`);
  }
  return { access: data.access_token, refresh: data.refresh_token, scopes: data.scope || "" };
}

// Profil Spotify du compte autorisé ; { error: "not_allowlisted" } si l'application refuse ce
// compte (absent de la liste User Management du tableau de bord)
export async function spotifyMe(access) {
  const r = await fetch("https://api.spotify.com/v1/me", { headers: { authorization: `Bearer ${access}` } });
  if (r.status === 403) return { error: "not_allowlisted" };
  if (!r.ok) throw new Error(`Spotify : profil illisible (HTTP ${r.status})`);
  const me = await r.json();
  if (!me?.id) throw new Error("Spotify : profil sans identifiant");
  return { id: String(me.id), name: me.display_name || null };
}
