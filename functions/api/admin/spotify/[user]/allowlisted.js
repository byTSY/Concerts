// POST /api/admin/spotify/:user/allowlisted : l'admin confirme avoir ajouté le compte dans le
// tableau de bord Spotify ; la source du membre passe à ready_to_connect (« Connecter Spotify »).

import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";

export const onRequestPost = ({ params, env }) => handle(async () => {
  await admin(env).spotifyAllowlisted(String(params.user));
  return json({ status: "ready_to_connect" });
});
