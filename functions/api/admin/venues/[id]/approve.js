// POST /api/admin/venues/:id/approve { note? } : salle publiée au catalogue (prise en compte par
// le traitement suivant ; aussitôt proposée comme salle favorite).

import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";
import { optionalNote } from "./reject.js";

export const onRequestPost = ({ request, params, env }) => handle(async () =>
  json(await admin(env).reviewVenue(String(params.id), "approved", await optionalNote(request))));
