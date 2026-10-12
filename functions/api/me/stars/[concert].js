// PUT /api/me/stars/:concert { label, status?, visibility? } : mettre un concert de côté
// (status interested ou going ; visibility private ou members, par défaut celle du membre).
// DELETE /api/me/stars/:concert : le retirer. Renvoient la liste à jour.

import { handle, json, readJson } from "../../../_lib/http.js";

export const onRequestPut = ({ request, params, data }) => handle(async () => {
  const body = await readJson(request);
  return json(await data.me.setStar(String(params.concert || ""), {
    label: body.label, status: body.status, visibility: body.visibility,
  }));
});

export const onRequestDelete = ({ params, data }) => handle(async () =>
  json(await data.me.deleteStar(String(params.concert || ""))));
