// POST /api/me/source/spotify/request { account_email, account_name } : demande de place
// Spotify (statut pending_allowlist) ; refusée si toutes les places sont prises. Renouvelée par
// le membre pour corriger son adresse tant que l'admin ne l'a pas traitée.

import { handle, json, readJson } from "../../../../_lib/http.js";

export const onRequestPost = ({ request, data }) => handle(async () => {
  const body = await readJson(request);
  return json(await data.me.requestSpotify({ account_email: body.account_email, account_name: body.account_name }));
});
