// POST /api/me/source/deezer/confirm { profile } : rattache le profil Deezer (vérifié à
// nouveau) et lance le calcul du membre.

import { dispatchRun } from "../../../../_lib/external.js";
import { handle, json } from "../../../../_lib/http.js";
import { notify } from "../../../../_lib/notify.js";
import { attempt } from "../../../../_lib/outside.js";
import { preview } from "./index.js";

export const onRequestPost = ({ request, env, data, waitUntil }) => handle(async () => {
  const profile = await data.me.connectDeezer(await preview(request, data));
  waitUntil(notify(env, { kind: "source_connected", userId: data.me.user.id, toAdmin: true, payload: { provider: "deezer" },
    dedupe: `source:${data.me.user.id}:${profile.source?.connected_at || ""}` }));
  const run = await attempt(() => dispatchRun(env, data.me.user.id));
  return json({ ...profile, run });
});
