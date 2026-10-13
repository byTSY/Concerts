// POST /api/venues/proposals { name, aliases?, agenda_url? } : proposer une salle au catalogue
// commun (statut pending, publiée après validation de l'admin).
// GET /api/venues/proposals : propositions du membre connecté et réponse de l'admin.

import { handle, json, readJson } from "../../_lib/http.js";

export const onRequestGet = ({ data }) => handle(async () => json(await data.me.venueProposals()));

export const onRequestPost = ({ request, data }) => handle(async () => {
  const body = await readJson(request);
  return json(await data.me.proposeVenue({ name: body.name, aliases: body.aliases, agenda_url: body.agenda_url }), 201);
});
