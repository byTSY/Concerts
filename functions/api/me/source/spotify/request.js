// POST /api/me/source/spotify/request { account_email, account_name } : demande de place
// Spotify (statut pending_allowlist) ; refusée si toutes les places sont prises. Renouvelée par
// le membre pour corriger son adresse tant que l'admin ne l'a pas traitée.

import { handle, json, readJson } from "../../../../_lib/http.js";
import { notify } from "../../../../_lib/notify.js";

export const onRequestPost = ({ request, env, data, waitUntil }) => handle(async () => {
  const body = await readJson(request);
  const profile = await data.me.requestSpotify({ account_email: body.account_email, account_name: body.account_name });
  const src = profile.source;
  if (src?.status === "pending_allowlist") {
    waitUntil(notify(env, { kind: "spotify_request", userId: data.me.user.id, toAdmin: true,
      payload: { account_name: src.spotify_account_name, account_email: src.spotify_account_email },
      dedupe: `spotify_request:${data.me.user.id}:${src.spotify_account_email}:${src.spotify_requested_at}` }));
  }
  return json(profile);
});
