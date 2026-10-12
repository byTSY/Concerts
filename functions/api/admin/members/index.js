// GET /api/admin/members : membres, statut, source, synchronisation, connexions et activité sur
// 30 jours, nombre de ★ (jamais d'artiste ni de concert).
// POST /api/admin/members { email, first_name } : invitation ; adresse ajoutée à la liste
// Access ; renvoie le lien à transmettre.

import { accessListAdd } from "../../../_lib/external.js";
import { handle, json, readJson } from "../../../_lib/http.js";
import { admin } from "../../../_lib/me.js";
import { attempt } from "../../../_lib/outside.js";

export const onRequestGet = ({ env }) => handle(async () => json(await admin(env).members()));

export const onRequestPost = ({ request, env }) => handle(async () => {
  const body = await readJson(request);
  const invited = await admin(env).invite({ email: body.email, first_name: body.first_name });
  const access = await attempt(() => accessListAdd(env, invited.email));
  return json({ member: invited, access, link: new URL("/", request.url).href }, 201);
});
