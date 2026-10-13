// GET /api/admin/invitations : liens d'invitation en attente (prénom, dates ; jamais le jeton).
// POST /api/admin/invitations { first_name } : nouveau lien d'invitation, à partager (WhatsApp, Messenger, Messages…) ;
// la personne y saisit elle-même son adresse e-mail.

import { handle, json, readJson } from "../../../_lib/http.js";
import { admin } from "../../../_lib/me.js";

export const invitationLink = (request, token) => new URL(`/invitation/${token}`, request.url).href;

export const onRequestGet = ({ env }) => handle(async () => json(await admin(env).invitations()));

export const onRequestPost = ({ request, env }) => handle(async () => {
  const body = await readJson(request);
  const { invitation, token } = await admin(env).createInvitationLink({ first_name: body.first_name });
  return json({ invitation, link: invitationLink(request, token) }, 201);
});
