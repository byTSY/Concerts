// POST /api/admin/members/:id/reactivate : retour au statut d'avant la suspension, adresse
// remise dans la liste Access.

import { accessListAdd } from "../../../../_lib/external.js";
import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";
import { attempt } from "../../../../_lib/outside.js";

export const onRequestPost = ({ params, env }) => handle(async () => {
  const row = await admin(env).reactivate(String(params.id));
  const access = await attempt(() => accessListAdd(env, row.email));
  return json({ status: row.status, access });
});
