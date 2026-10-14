// POST /api/venues/proposals { name, aliases?, agenda_url? } : proposer une salle au catalogue
// commun (statut pending). Avec page programme : vérification automatique lancée aussitôt
// (ajout au catalogue si la lecture réussit, sinon validation par l'admin) ; sans page programme :
// validation par l'admin.
// GET /api/venues/proposals : propositions du membre connecté et réponse de l'admin.

import { handle, json, readJson } from "../../_lib/http.js";
import { startVenueCheck } from "../../_lib/venuecheck.js";

export const onRequestGet = ({ data }) => handle(async () => json(await data.me.venueProposals()));

export const onRequestPost = ({ request, data, env }) => handle(async () => {
  const body = await readJson(request);
  const { proposals, check } = await data.me.proposeVenue({ name: body.name, aliases: body.aliases, agenda_url: body.agenda_url });
  if (!check) return json(proposals, 201);
  const run = await startVenueCheck(env, check);
  return json(run.done ? proposals : await data.me.venueProposals(), 201);
});
