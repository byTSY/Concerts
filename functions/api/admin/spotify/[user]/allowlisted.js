// POST /api/admin/spotify/:user/allowlisted : l'admin confirme avoir ajouté le compte dans le
// tableau de bord Spotify ; la source du membre passe à ready_to_connect (« Connecter Spotify ») ;
// le membre en est averti par e-mail.

import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";
import { notify } from "../../../../_lib/notify.js";

export const onRequestPost = ({ params, env, waitUntil }) => handle(async () => {
  const row = await admin(env).spotifyAllowlisted(String(params.user));
  waitUntil(notify(env, { kind: "spotify_ready", userId: row.id, dedupe: `spotify_ready:${row.id}:${new Date().toISOString().slice(0, 16)}` }));
  return json({ status: "ready_to_connect" });
});
