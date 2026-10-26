// Page d'invitation, accessible sans connexion (chemin /invitation/ ouvert à tous dans
// Cloudflare Access, comme /partage/) : la personne invitée par un lien y saisit son adresse
// e-mail et choisit sa source musicale (version 1.13.0) ; l'adresse est inscrite et ajoutée à la
// liste Access des membres. Elle se connecte ensuite au site avec le code reçu par e-mail.
// Le lien utilisé reste 24 heures pour corriger une adresse mal saisie, tant que la personne ne
// s'est pas connectée.
//
// GET  /invitation/<jeton> -> formulaire, ou adresse inscrite à corriger, ou « lien expiré »
// POST /invitation/<jeton> -> inscription, ou correction (champ action=correct) ; formulaire du
//                             site seulement

import { accessListAdd, accessListRemove } from "../_lib/external.js";
import { HttpError } from "../_lib/http.js";
import { claimInvitation, correctInvitationEmail, findClaimedInvitation, findInvitation, setAccessPending,
  spotifyOpenForInvitation } from "../_lib/me.js";
import { notify } from "../_lib/notify.js";
import { attempt } from "../_lib/outside.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Secret de l'inscription, gardé par le navigateur qui l'a faite (correction de l'adresse)
const SECRET_COOKIE = "invitation_secret";
const readSecret = (request) => (request.headers.get("cookie") || "").split(/;\s*/)
  .map((c) => c.split("=")).find(([k]) => k === SECRET_COOKIE)?.[1] || "";
// Lax : envoyé quand la personne rouvre le lien depuis un SMS ou un e-mail
const secretCookie = (secret) => `${SECRET_COOKIE}=${secret}; Path=/invitation/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`;

function page(title, body, status = 200, extraHeaders = {}) {
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<meta property="og:title" content="Invitation : Concerts à Paris"><meta property="og:type" content="website">
<meta property="og:description" content="Les concerts de vos artistes à Paris, à partir de votre bibliothèque Deezer ou Spotify. Ouvrez le lien pour vous inscrire.">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 520px; margin: 40px auto; padding: 0 16px; line-height: 1.5; color: #1e2350; background: #f6f3ec; }
  h1 { font-size: 1.6rem; margin-bottom: .4em; }
  label { display: block; margin-top: 14px; font-weight: 600; }
  input[type=email] { width: 100%; box-sizing: border-box; font: inherit; padding: 10px 12px; margin-top: 4px; border: 1.5px solid #c9c4b8; border-radius: 8px; background: #fff; }
  fieldset { border: 0; margin: 18px 0 0; padding: 0; }
  legend { font-weight: 600; padding: 0; }
  .choice { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  .choice label { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 16px; border: 1.5px solid #c9c4b8; border-radius: 8px; cursor: pointer; }
  .choice label:has(input:checked) { border-color: #1e2350; box-shadow: inset 0 0 0 1px #1e2350; }
  .choice input { margin: 0; accent-color: #1e2350; }
  .sp-only { display: none; }
  form:has(#src-spotify:checked) .sp-only { display: block; }
  button, .btn { display: inline-block; margin-top: 18px; padding: 10px 18px; border: 0; border-radius: 8px; font: inherit; font-weight: 600; background: #1e2350; color: #fff; text-decoration: none; cursor: pointer; }
  .note { font-size: .9rem; color: #555; }
  .warn { padding: 10px 14px; border-radius: 8px; background: #ffe45c; }
  .address { font-size: 1.15rem; font-weight: 700; word-break: break-all; }
  details { margin-top: 1.6em; }
  summary { cursor: pointer; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    body { color: #ece9f6; background: #171a33; }
    input[type=email] { background: #23274a; color: #ece9f6; border-color: #3b4070; }
    .choice label { border-color: #3b4070; }
    .choice label:has(input:checked) { border-color: #ece9f6; box-shadow: inset 0 0 0 1px #ece9f6; }
    .choice input { accent-color: #ece9f6; }
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
      ...extraHeaders,
    },
  });
}

const expired = () => page("Lien expiré", `<h1>Ce lien ne fonctionne plus</h1>
  <p>Il a déjà servi, ou il a expiré (un lien d'invitation est valable 7 jours). Demandez un nouveau lien à la personne qui vous a invité.</p>
  <p class="note">Si vous vous êtes déjà inscrit, ouvrez simplement le site et connectez-vous avec votre adresse e-mail.</p>`, 410);

// Formulaire d'inscription. offer : { prepared (compte Spotify préparé par l'admin), spotify (choix possible) }
function form(first, offer, { error = "", email = "", source = "deezer", spotifyEmail = "" } = {}) {
  const choice = offer.prepared
    ? `<p class="note">Votre compte Spotify est déjà prévu : après la connexion, il vous restera à cliquer sur « Connecter Spotify ».</p>`
    : offer.spotify
      ? `<fieldset><legend>Votre application de musique</legend>
    <div class="choice">
      <label><input type="radio" name="source" value="deezer"${source !== "spotify" ? " checked" : ""}> Deezer</label>
      <label><input type="radio" name="source" value="spotify" id="src-spotify"${source === "spotify" ? " checked" : ""}> Spotify</label>
    </div></fieldset>
    <div class="sp-only">
      <label for="spotify_email">E-mail de votre compte Spotify, s'il est différent</label>
      <input id="spotify_email" name="spotify_email" type="email" autocomplete="off" maxlength="200" value="${esc(spotifyEmail)}">
      <p class="note">Spotify n'ouvre l'application qu'aux comptes ajoutés un par un : votre demande part tout de suite à l'admin. Laissez vide si c'est l'adresse ci-dessus.</p>
    </div>`
      : "";
  return page("Invitation", `<h1>Bonjour ${esc(first)}</h1>
  <p>Vous êtes invité sur <strong>Concerts à Paris</strong>, qui repère les concerts de vos artistes à Paris à partir de votre bibliothèque Deezer ou Spotify.</p>
  ${error ? `<p class="warn">${esc(error)}</p>` : ""}
  <form method="post">
    <label for="email">Votre adresse e-mail</label>
    <input id="email" name="email" type="email" autocomplete="email" required maxlength="200" value="${esc(email)}">
    <p class="note">Elle sert à vous connecter, avec un code envoyé par e-mail. Aucun mot de passe.</p>
    ${choice}
    <button type="submit">Valider</button>
  </form>
  <p class="note">Données conservées : votre adresse e-mail, votre prénom ou pseudo, votre source musicale, vos préférences et vos concerts mis de côté. Vous pourrez supprimer votre compte à tout moment.</p>`);
}

// Inscription faite (ou lien rouvert dans les 24 heures) : adresse en évidence, bouton vers le
// site et correction de l'adresse
function done(member, { accessPending = false, spotify = "", error = "", corrected = false, secret = "" } = {}, home) {
  return page("Inscription faite", `<h1>C'est fait, ${esc(member.first_name)}</h1>
    ${corrected ? `<p class="warn">Adresse corrigée.</p>` : ""}
    <p>Vous êtes inscrit avec l'adresse :</p>
    <p class="address">${esc(member.email)}</p>
    ${accessPending ? `<p class="warn">Votre accès doit encore être activé par l'admin, qui vous préviendra.</p>` : ""}
    ${spotify ? `<p>${spotify}</p>` : ""}
    <p><a class="btn" href="${esc(home)}">Ouvrir Concerts à Paris</a></p>
    <p class="note">Sur la page suivante, saisissez cette adresse : un code de connexion vous est envoyé par e-mail.</p>
    <details${error ? " open" : ""}><summary>Ce n'est pas la bonne adresse ?</summary>
      ${error ? `<p class="warn">${esc(error)}</p>` : ""}
      <form method="post">
        <input type="hidden" name="action" value="correct">
        <label for="email">Adresse corrigée</label>
        <input id="email" name="email" type="email" autocomplete="email" required maxlength="200">
        <button type="submit">Corriger</button>
      </form>
      <p class="note">Possible pendant 24 heures depuis ce téléphone ou cet ordinateur, tant que vous ne vous êtes pas connecté.</p>
    </details>`, 200, secret ? { "set-cookie": secretCookie(secret) } : {});
}

const SPOTIFY_SENT = "Votre demande Spotify est envoyée à l'admin. Vous recevrez un e-mail quand vous pourrez connecter Spotify ; en attendant, vous pouvez déjà vous connecter.";
const SPOTIFY_FULL = "Les places Spotify viennent d'être prises : vous choisirez votre source sur le site (Deezer, ou Spotify si une place se libère).";
const SPOTIFY_PREPARED = "Après la connexion, cliquez sur « Connecter Spotify » : votre compte Spotify est déjà autorisé.";

const spotifyNotice = (env, userId, request) => notify(env, { kind: "spotify_request", userId, toAdmin: true,
  payload: { account_name: request.account_name, account_email: request.account_email },
  dedupe: `spotify_request:${userId}:${request.account_email}:${request.requested_at}` });

// Ajout à la liste Access ; échec signalé à l'admin dans la liste des membres (bouton pour relancer)
async function grantAccess(env, email) {
  const access = await attempt(() => accessListAdd(env, email));
  await setAccessPending(env, email, access?.done === false).catch(() => {});
  return access?.done === false;
}

export async function onRequest({ request, env, params, waitUntil }) {
  const token = (params.path || []).join("/");
  if (!["GET", "HEAD", "POST"].includes(request.method)) return new Response(null, { status: 405 });
  if (!env.DB) return page("Indisponible", "<h1>Service indisponible</h1><p>Réessayez dans quelques minutes.</p>", 503);
  const home = new URL("/", request.url).href;
  const invitation = await findInvitation(env, token);
  const secret = readSecret(request);
  const claimed = invitation ? null : await findClaimedInvitation(env, token, secret);
  // Lien déjà utilisé : correction possible depuis le navigateur de l'inscription, tant que la
  // personne ne s'est pas connectée
  if (!invitation && (!claimed || claimed.status !== "invited")) return expired();
  const offer = invitation
    ? { prepared: Boolean(invitation.spotify_account_email), spotify: await spotifyOpenForInvitation(env) }
    : null;
  if (request.method !== "POST") return invitation ? form(invitation.first_name, offer) : done(claimed, {}, home);

  // Formulaire envoyé depuis cette page seulement : Sec-Fetch-Site d'abord (navigateurs
  // récents), sinon Origin (certains navigateurs envoient « null » pour un formulaire)
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const sameSite = site ? site === "same-origin" : !origin || origin === new URL(request.url).origin;
  if (!sameSite) return page("Refusé", "<h1>Requête refusée</h1>", 403);
  const data = await request.formData().catch(() => null);
  const email = String(data?.get("email") || "").trim();

  if (!invitation) {
    // Formulaire d'inscription renvoyé (second onglet, double envoi) : rien à corriger
    if (data?.get("action") !== "correct") return done(claimed, {}, home);
    let fixed;
    try {
      fixed = await correctInvitationEmail(env, token, secret, email);
    } catch (e) {
      if (e instanceof HttpError && e.code === "expired") return expired();
      const message = e instanceof HttpError ? e.message : "Erreur inattendue : réessayez dans quelques minutes.";
      if (!(e instanceof HttpError)) console.error(`Correction : ${e?.name || "Error"} ${String(e?.message || "").slice(0, 200)}`);
      return done(claimed, { error: message }, home);
    }
    if (fixed.old_email === fixed.email) return done(claimed, {}, home);
    await attempt(() => accessListRemove(env, fixed.old_email));
    const accessPending = await grantAccess(env, fixed.email);
    waitUntil?.(notify(env, { kind: "member_joined", userId: fixed.id, toAdmin: true, payload: { corrected: true, spotify: Boolean(fixed.spotify_request) },
      dedupe: `joined:${fixed.id}:${fixed.email}:${Date.now()}` }));
    if (fixed.spotify_request) waitUntil?.(spotifyNotice(env, fixed.id, fixed.spotify_request));
    return done({ ...claimed, email: fixed.email }, { accessPending, corrected: true }, home);
  }

  const source = data?.get("source") === "spotify" ? "spotify" : "deezer";
  const spotifyEmail = String(data?.get("spotify_email") || "").trim();
  let member;
  try {
    member = await claimInvitation(env, token, email, { source: offer.prepared ? "deezer" : source, spotifyEmail });
  } catch (e) {
    if (e instanceof HttpError && e.code === "expired") {
      // Double envoi : l'autre envoi a fait l'inscription depuis ce navigateur
      const mine = await findClaimedInvitation(env, token, secret);
      return mine?.status === "invited" ? done(mine, {}, home) : expired();
    }
    const values = { email, source, spotifyEmail };
    if (e instanceof HttpError) return form(invitation.first_name, offer, { ...values, error: e.message });
    console.error(`Invitation : ${e?.name || "Error"} ${String(e?.message || "").slice(0, 200)}`);
    return form(invitation.first_name, offer, { ...values, error: "Erreur inattendue : réessayez dans quelques minutes." });
  }
  waitUntil?.(notify(env, { kind: "member_joined", userId: member.id, toAdmin: true,
    payload: { spotify: member.spotify, spotify_requested: Boolean(member.spotify_request) }, dedupe: `joined:${member.id}` }));
  if (member.spotify_request) waitUntil?.(spotifyNotice(env, member.id, member.spotify_request));
  const accessPending = await grantAccess(env, member.email);
  const spotify = member.spotify ? SPOTIFY_PREPARED : member.spotify_request ? SPOTIFY_SENT : member.spotify_full ? SPOTIFY_FULL : "";
  return done(member, { accessPending, spotify, secret: member.secret }, home);
}
