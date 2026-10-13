// GET /api/community/stars : ★ partagés par les autres membres (visibilité « members », membres
// non suspendus) : concert, nom affiché, statut (interested ou going). Jamais un ★ masqué (private), jamais
// d'identifiant de membre.

import { handle, json } from "../../_lib/http.js";
import { communityStars } from "../../_lib/me.js";

export const onRequestGet = ({ env, data }) => handle(async () => json(await communityStars(env, data.me.user.id)));
