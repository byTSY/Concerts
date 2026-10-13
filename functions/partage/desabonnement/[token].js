// Désabonnement de la newsletter du lundi par le lien de l'e-mail (version 1.5.0). Page publique
// comme le reste de /partage/ : le jeton personnel (users.newsletter_token) suffit.
// GET : page de confirmation (un simple affichage ne désabonne pas : les messageries ouvrent
// parfois les liens d'elles-mêmes). POST : désabonnement, depuis le bouton de la page ou depuis
// la messagerie (en-tête List-Unsubscribe-Post, RFC 8058).

import { knownToken, unsubscribeByToken } from "../../_lib/me.js";

const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5;color:#1e2350">
<h1 style="color:#0078bf">${title}</h1>${body}</body></html>`,
{ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

const invalid = () => page("Lien invalide",
  "<p>Ce lien de désabonnement n'est pas reconnu. Vous pouvez régler la newsletter dans « Mon compte » sur le site.</p>", 404);

export async function onRequestGet({ env, params }) {
  if (!(await knownToken(env, params.token))) return invalid();
  return page("Newsletter du lundi", `<p>Ne plus recevoir la newsletter de Concerts à Paris ?</p>
<form method="post"><button type="submit" style="font:inherit;font-weight:700;padding:10px 16px;border:0;border-radius:6px;background:#0078bf;color:#fff;cursor:pointer">Me désabonner</button></form>
<p style="color:#565b78;font-size:14px">Vous pourrez vous réabonner à tout moment dans « Mon compte ».</p>`);
}

export async function onRequestPost({ env, params }) {
  if (!(await unsubscribeByToken(env, params.token))) return invalid();
  return page("C'est fait", `<p>Vous ne recevrez plus la newsletter du lundi.</p>
<p style="color:#565b78;font-size:14px">Pour la recevoir à nouveau : « Mon compte » sur le site Concerts à Paris.</p>`);
}
