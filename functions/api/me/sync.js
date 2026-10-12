// POST /api/me/sync : « Synchroniser maintenant » (une fois par heure au plus).

import { dispatchRun } from "../../_lib/external.js";
import { handle, json } from "../../_lib/http.js";
import { attempt } from "../../_lib/outside.js";

export const onRequestPost = ({ env, data }) => handle(async () => {
  const profile = await data.me.requestSync();
  const run = await attempt(() => dispatchRun(env, data.me.user.id));
  return json({ ...profile, run });
});
