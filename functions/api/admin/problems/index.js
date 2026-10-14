// GET /api/admin/problems : signalements « J'ai un problème » (ouverts, puis 20 derniers résolus).

import { handle, HttpError, json } from "../../../_lib/http.js";
import { admin } from "../../../_lib/me.js";

export const onRequestGet = ({ env }) => handle(async () => {
  const list = await admin(env).problems();
  if (list === null) throw new HttpError(503, "signalements pas encore disponibles (migration 0011)", "problems_unavailable");
  return json(list);
});
