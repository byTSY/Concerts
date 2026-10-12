// POST /api/admin/members/:id/suspend : accès coupé (statut suspended, liste Access, sessions),
// données gardées.

import { accessListRemove, revokeSessions } from "../../../../_lib/external.js";
import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";
import { attempt } from "../../../../_lib/outside.js";

export const onRequestPost = ({ params, env }) => handle(async () => {
  const row = await admin(env).suspend(String(params.id));
  const access = await attempt(() => accessListRemove(env, row.email));
  const sessions = await attempt(() => revokeSessions(env, row.email));
  return json({ status: row.status, access, sessions });
});
