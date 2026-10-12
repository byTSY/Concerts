// GET /api/me/artists : liste d'artistes du membre (artists.json), {} avant le premier calcul.

import { handle, json } from "../../../_lib/http.js";

export const onRequestGet = ({ data }) => handle(async () => {
  const obj = await data.me.artistsObject();
  if (!obj) return json({});
  return new Response(obj.body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
});
