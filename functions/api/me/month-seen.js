// GET /api/me/month-seen : concerts déjà parcourus dans les cercles des mois.
// POST /api/me/month-seen { items: [{ id, month }] } : les marquer comme vus (50 au plus par appel).
// DELETE /api/me/month-seen { month, ids? } : « Tout revoir » pour ce mois (ids : concerts affichés
// dans ce mois, au cas où l'un d'eux aurait changé de date depuis son passage).
// Renvoient la liste à jour : [{ id, month }].

import { handle, json, readJson } from "../../_lib/http.js";

export const onRequestGet = ({ data }) => handle(async () => json(await data.me.monthSeen()));

export const onRequestPost = ({ request, data }) => handle(async () => {
  const body = await readJson(request);
  return json(await data.me.markMonthSeen(body.items));
});

export const onRequestDelete = ({ request, data }) => handle(async () => {
  const body = await readJson(request);
  return json(await data.me.resetMonthSeen(body.month, body.ids));
});
