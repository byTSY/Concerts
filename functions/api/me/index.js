// GET /api/me : profil, statut, nom affiché, visibilité par défaut des ★, source musicale et
// état de la synchronisation, salles favorites.

import { handle, json } from "../../_lib/http.js";

export const onRequestGet = ({ data }) => handle(async () => json(await data.me.profile()));
