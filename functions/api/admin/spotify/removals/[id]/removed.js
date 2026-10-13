// POST /api/admin/spotify/removals/:id/removed : l'admin confirme avoir retiré le compte du
// tableau de bord Spotify ; la place est libérée, le nom et l'e-mail Spotify sont effacés.
// (La spécification prévoyait /api/admin/spotify/:user/removed ; après suppression le membre
// n'existe plus, la tâche de retrait a donc son propre identifiant.)

import { handle, json } from "../../../../../_lib/http.js";
import { admin } from "../../../../../_lib/me.js";

export const onRequestPost = ({ params, env }) => handle(async () => json(await admin(env).spotifyRemoved(String(params.id))));
