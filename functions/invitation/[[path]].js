// Page d'invitation, accessible sans connexion (chemin /invitation/ ouvert à tous dans
// Cloudflare Access, comme /partage/) : la personne invitée par un lien y saisit son adresse
// e-mail, qui est inscrite et ajoutée à la liste Access des membres. Elle se connecte ensuite
// au site avec le code reçu par e-mail.
//
// GET  /invitation/<jeton> -> formulaire (ou « lien expiré »)
// POST /invitation/<jeton> -> inscription de l'adresse (formulaire du site seulement)

import { accessListAdd } from "../_lib/external.js";
import { HttpError } from "../_lib/http.js";
import { claimInvitation, findInvitation, setAccessPending } from "../_lib/me.js";
import { attempt } from "../_lib/outside.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 520px; margin: 40px auto; padding: 0 16px; line-height: 1.5; color: #1e2350; background: #f6f3ec; }
  h1 { font-size: 1.6rem; margin-bottom: .4em; }
  label { display: block; margin-top: 14px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 10px 12px; margin-top: 4px; border: 1.5px solid #c9c4b8; border-radius: 8px; background: #fff; }
  button, .btn { display: inline-block; margin-top: 18px; padding: 10px 18px; border: 0; border-radius: 8px; font: inherit; font-weight: 600; background: #1e2350; color: #fff; text-decoration: none; cursor: pointer; }
  .note { font-size: .9rem; color: #555; }
  .warn { padding: 10px 14px; border-radius: 8px; background: #ffe45c; }
  @media (prefers-color-scheme: dark) {
    body { color: #ece9f6; background: #171a33; }
    input { background: #23274a; color: #ece9f6; border-color: #3b4070; }
    button, .btn { background: #ece9f6; color: #171a33; }
    .note { color: #b8b5c8; }
    .warn { color: #1e2350; }
  }
</style></head><body>${body}</body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Le jeton est dans l'adresse : il ne doit partir vers aucun autre site
      "referrer-policy": "same-origin",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const expired = () => page("Lien expiré", `<h1>Ce lien ne fonctionne plus</h1>
  <p>Il a déjà servi, ou il a expiré (un lien d'invitation est valable 7 jours). Demandez un nouveau lien à la personne qui vous a invité.</p>
  <p class="note">Si vous vous êtes déjà inscrit, ouvrez simplement le site et connectez-vous avec votre adresse e-mail.</p>`, 410);

function form(first, error = "", email = "") {
  return page("Invitation", `<h1>Bonjour ${esc(first)}</h1>
  <p>Vous êtes invité sur <strong>Concerts à Paris</strong>, qui repère les concerts de vos artistes à Paris à partir de votre bibliothèque Deezer ou Spotify.</p>
  <p>Indiquez votre adresse e-mail : elle vous servira à vous connecter, avec un code envoyé à chaque nouvelle connexion. Aucun mot de passe.</p>
  ${error ? `<p class="warn">${esc(error)}</p>` : ""}
  <form method="post">
    <label for="email">Votre adresse e-mail</label>
    <input id="email" name="email" type="email" autocomplete="email" required maxlength="200" value="${esc(email)}">
    <label for="email2">La même adresse, une seconde fois</label>
    <input id="email2" name="email2" type="email" autocomplete="email" required maxlength="200">
    <button type="submit">Valider</button>
  </form>
  <p class="note">Données conservées : votre adresse e-mail, votre prénom ou pseudo, votre source musicale, vos préférences et vos concerts mis de côté. Vous pourrez supprimer votre compte à tout moment.</p>`);
}

export async function onRequest({ request, env, params }) {
  const token = (params.path || []).join("/");
  if (!["GET", "HEAD", "POST"].includes(request.method)) return new Response(null, { status: 405 });
  if (!env.DB) return page("Indisponible", "<h1>Service indisponible</h1><p>Réessayez dans quelques minutes.</p>", 503);
  const invitation = await findInvitation(env, token);
  if (!invitation) return expired();
  if (request.method !== "POST") return form(invitation.first_name);

  // Formulaire envoyé depuis cette page seulement : Sec-Fetch-Site d'abord (navigateurs
  // récents), sinon Origin (certains navigateurs envoient « null » pour un formulaire)
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const sameSite = site ? site === "same-origin" : !origin || origin === new URL(request.url).origin;
  if (!sameSite) return page("Refusé", "<h1>Requête refusée</h1>", 403);
  const data = await request.formData().catch(() => null);
  const email = String(data?.get("email") || "").trim();
  if (email.toLowerCase() !== String(data?.get("email2") || "").trim().toLowerCase()) {
    return form(invitation.first_name, "Les deux adresses diffèrent.", email);
  }
  let member;
  try {
    member = await claimInvitation(env, token, email);
  } catch (e) {
    if (e instanceof HttpError && e.code === "expired") return expired();
    if (e instanceof HttpError) return form(invitation.first_name, e.message, email);
    console.error(`Invitation : ${e?.name || "Error"} ${String(e?.message || "").slice(0, 200)}`);
    return form(invitation.first_name, "Erreur inattendue : réessayez dans quelques minutes.", email);
  }
  const access = await attempt(() => accessListAdd(env, member.email));
  // Échec : signalé à l'admin dans la liste des membres, avec un bouton pour relancer
  if (access?.done === false) await setAccessPending(env, member.email, true).catch(() => {});
  const home = new URL("/", request.url).href;
  return page("Inscription faite", `<h1>C'est fait, ${esc(member.first_name)}</h1>
    <p>Votre adresse <strong>${esc(member.email)}</strong> est inscrite.</p>
    ${access?.done === false ? `<p class="warn">Votre accès doit encore être activé par l'admin : il vous préviendra.</p>` : ""}
    <p>Ouvrez maintenant le site et saisissez cette adresse : un code de connexion vous sera envoyé par e-mail. Il peut falloir attendre une minute avant que l'adresse soit reconnue.</p>
    <p><a class="btn" href="${esc(home)}">Ouvrir Concerts à Paris</a></p>
    <p class="note">Ensuite, vous choisirez votre source musicale (Deezer ou Spotify). Pensez à ajouter le site à l'écran d'accueil de votre téléphone.</p>`);
}
