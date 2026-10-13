// GET /api/me/seen : identifiants des fiches Reels déjà vues par le membre.
// POST /api/me/seen { ids: [...] } : marquer des fiches comme vues (50 au plus par appel).
// Renvoient la liste à jour.

import { handle, json, readJson } from "../../_lib/http.js";

export const onRequestGet = ({ data }) => handle(async () => json(await data.me.seenCards()));

export const onRequestPost = ({ request, data }) => handle(async () => {
  const body = await readJson(request);
  return json(await data.me.markSeen(body.ids));
});
