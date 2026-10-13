// POST /api/admin/invitations/:id/renew : nouveau lien (7 jours) pour la même personne ; l'ancien
// ne fonctionne plus.

import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";
import { invitationLink } from "../index.js";

export const onRequestPost = ({ request, params, env }) => handle(async () => {
  const { invitation, token } = await admin(env).renewInvitation(String(params.id));
  return json({ invitation, link: invitationLink(request, token) });
});
