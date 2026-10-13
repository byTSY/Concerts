// PUT /api/me/removed/:concert { label, date, venue?, title?, urls? } : ne plus voir ce concert
// (sa ★ est effacée) ; renvoie { removed, stars }.
// DELETE /api/me/removed/:concert : le remettre ; renvoie la liste à jour.

import { handle, json, readJson } from "../../../_lib/http.js";

export const onRequestPut = ({ request, params, data }) => handle(async () => {
  const body = await readJson(request);
  return json(await data.me.removeConcert(String(params.concert || ""), {
    label: body.label, date: body.date, venue: body.venue, title: body.title, urls: body.urls,
  }));
});

export const onRequestDelete = ({ params, data }) => handle(async () =>
  json(await data.me.restoreConcert(String(params.concert || ""))));
