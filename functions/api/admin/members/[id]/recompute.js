// POST /api/admin/members/:id/recompute : relance le calcul du membre.

import { dispatchRun } from "../../../../_lib/external.js";
import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";
import { attempt } from "../../../../_lib/outside.js";

export const onRequestPost = ({ params, env }) => handle(async () => {
  const row = await admin(env).requestRecompute(String(params.id));
  const run = await attempt(() => dispatchRun(env, row.id));
  return json({ requested: true, run });
});
