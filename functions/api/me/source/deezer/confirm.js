// POST /api/me/source/deezer/confirm { profile } : rattache le profil Deezer (vérifié à
// nouveau) et lance le calcul du membre.

import { dispatchRun } from "../../../../_lib/external.js";
import { handle, json } from "../../../../_lib/http.js";
import { attempt } from "../../../../_lib/outside.js";
import { preview } from "./index.js";

export const onRequestPost = ({ request, env, data }) => handle(async () => {
  const profile = await data.me.connectDeezer(await preview(request, data));
  const run = await attempt(() => dispatchRun(env, data.me.user.id));
  return json({ ...profile, run });
});
