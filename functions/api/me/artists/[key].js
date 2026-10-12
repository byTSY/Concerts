// PUT /api/me/artists/:key { name?, hidden?, level? } : masquer un artiste ou lui imposer un
// niveau (1, 2, 3 ; null pour revenir au niveau calculé). :key est le nom normalisé (norm).
// Renvoie les préférences à jour.

import { handle, json, readJson } from "../../../_lib/http.js";

export const onRequestPut = ({ request, params, data }) => handle(async () => {
  const body = await readJson(request);
  let key = String(params.key || "");
  try { key = decodeURIComponent(key); } catch { /* clé laissée telle quelle, refusée plus loin */ }
  return json(await data.me.setArtistPref(key, {
    name: body.name === undefined ? undefined : String(body.name),
    hidden: body.hidden,
    level: body.level,
  }));
});
