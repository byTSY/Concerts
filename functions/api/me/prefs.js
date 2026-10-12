// GET /api/me/prefs : préférences du membre, { hidden: [noms], levels: { nom: niveau } }.

import { handle, json } from "../../_lib/http.js";

export const onRequestGet = ({ data }) => handle(async () => json(await data.me.prefs()));
