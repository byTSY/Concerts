// GET /api/me/concerts : concerts retenus pour le membre (overlay.json) et compteurs du dernier
// calcul (meta.json), { overlay: { <concert>: {...} }, meta: {...} }.

import { handle } from "../../_lib/http.js";

export const onRequestGet = ({ data }) => handle(async () =>
  new Response(await data.me.concertsBody(), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  }));
