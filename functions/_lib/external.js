// Services extérieurs appelés par les fonctions : liste Access des membres et révocation des
// sessions (API Cloudflare), lancement d'un calcul (GitHub Actions), profil public Deezer.
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

// Nom, photo et nombre d'artistes favoris ; { error: "not_found" | "private_profile" }
export async function deezerProfile(id) {
  const get = async (path) => {
    const r = await fetch(`https://api.deezer.com${path}`);
    return r.ok ? r.json() : { error: { code: r.status } };
  };
  const user = await get(`/user/${id}`);
  if (!user || user.error || !user.id) return { error: "not_found" };
  const favs = await get(`/user/${id}/artists?limit=1`);
  if (!favs || favs.error) return { error: "private_profile" };
  return { id: String(user.id), name: user.name, picture: user.picture_medium || null, favorites: favs.total ?? (favs.data || []).length };
}
