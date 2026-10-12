// GET /api/venues : catalogue commun des salles approuvées (sans l'auteur des propositions).

import { handle, json } from "../../_lib/http.js";

export const onRequestGet = ({ env }) => handle(async () => {
  const { results } = await env.DB.prepare(
    "SELECT id, name, aliases, agenda_url, excluded FROM venues WHERE status = 'approved' ORDER BY name").all();
  return json(results.map((v) => ({ ...v, aliases: JSON.parse(v.aliases || "[]"), excluded: Boolean(v.excluded) })));
});
