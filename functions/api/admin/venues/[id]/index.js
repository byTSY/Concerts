// PATCH /api/admin/venues/:id { name?, aliases?, agenda_url?, excluded? } : correction d'une salle
// du catalogue ou d'une proposition avant validation.

import { handle, json, readJson } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";

export const onRequestPatch = ({ request, params, env }) => handle(async () => {
  const body = await readJson(request);
  return json(await admin(env).updateVenue(String(params.id), {
    name: body.name, aliases: body.aliases, agenda_url: body.agenda_url, excluded: body.excluded,
  }));
});
