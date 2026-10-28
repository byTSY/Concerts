// Lien d'invité (version 1.15.0) : /visite/<jeton>/ montre l'application sans connexion, sur
// l'univers de l'admin qui a créé le lien (functions/_lib/me.js, guestUniverse). Chemin ouvert à
// tous dans Cloudflare Access, comme /partage/ et /invitation/.
//
//   /visite/<jeton>            -> redirection vers /visite/<jeton>/ (chemins relatifs du site)
//   /visite/<jeton>/           -> index.html du site, en mode invité (window.GUEST_MODE)
//   /visite/<jeton>/api/guest  -> univers de l'invité, en lecture seule
//   /visite/<jeton>/data/...   -> catalogue commun (events.json, meta.json, venues.json)
//   /visite/<jeton>/<fichier>  -> scripts, style et bibliothèques du site
//
// Rien d'autre : aucune route /api/me/*, aucune écriture (GET et HEAD seulement). Les actions de
// l'invité (★, retraits, fiches vues) restent dans la mémoire de son navigateur (site/guest.js).
// Lien inconnu ou remplacé : page « lien plus valable », sans rien du site.

import { guestOwner, guestUniverse } from "../_lib/me.js";

const DATA = new Set(["events.json", "meta.json", "venues.json"]);
const FILE = /^(?:vendor\/)?[a-z0-9][a-z0-9.-]*\.(?:js|css|png)$/;
const TYPES = { js: /javascript/, css: /css/, png: /image\/png/, json: /json/ };
// Pas d'adresse de la page (donc du jeton) envoyée aux billetteries et sites des salles
const PRIVATE = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex", "cache-control": "no-store" };

function invalid(status = 404) {
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lien plus valable</title><meta name="robots" content="noindex"></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5">
<h1>Lien plus valable</h1><p>Ce lien d'invité a été remplacé ou retiré. Demandez un nouveau lien à la personne qui vous l'a envoyé.</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", ...PRIVATE } });
}

const notFound = () => new Response("introuvable", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...PRIVATE } });

async function asset(env, request, path) {
  const r = await env.ASSETS.fetch(new URL(path, request.url));
  // Fichier absent : Pages renvoie la page d'accueil (200, HTML) ; seul le type attendu est servi
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !TYPES[path.split(".").pop()].test(type)) {
    await r.body?.cancel();
    return notFound();
  }
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries(PRIVATE)) headers.set(k, v);
  return new Response(r.body, { status: r.status, headers });
}

export async function onRequest({ request, env, params }) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response("lecture seule", { status: 405, headers: { allow: "GET, HEAD", ...PRIVATE } });
  }
  const [token = "", ...rest] = (params.path || []).filter(Boolean);  // « /visite/<jeton>/ » : segment vide final ignoré
  const owner = env.DB ? await guestOwner(env, token) : null;
  if (!owner) return invalid();
  const url = new URL(request.url);
  if (!rest.length) {
    if (!url.pathname.endsWith("/")) return Response.redirect(new URL(`/visite/${token}/`, url).href, 302);
    const page = await env.ASSETS.fetch(new URL("/", url));
    if (!page.ok) return notFound();
    const html = (await page.text()).replace("<head>",
      `<head>\n  <meta name="referrer" content="no-referrer">\n  <meta name="robots" content="noindex">\n  <script>window.GUEST_MODE = true;</script>`);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...PRIVATE } });
  }
  const sub = rest.join("/");
  if (sub === "api/guest") {
    try {
      return new Response(await guestUniverse(env, owner), { headers: { "content-type": "application/json; charset=utf-8", ...PRIVATE } });
    } catch (e) {
      console.error(`Univers invité illisible : ${e?.message}`);
      return new Response(JSON.stringify({ error: "données indisponibles" }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", ...PRIVATE } });
    }
  }
  if (rest[0] === "data" && rest.length === 2 && DATA.has(rest[1])) return asset(env, request, `/data/${rest[1]}`);
  if (rest[0] !== "data" && rest[0] !== "api" && FILE.test(sub)) return asset(env, request, `/${sub}`);
  return notFound();
}
