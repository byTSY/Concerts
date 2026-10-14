// POST /api/admin/venues/:id/check : « Relancer la vérification » d'une salle en attente (après
// correction de sa page programme, par exemple). Résultat dans l'Admin et par e-mail.

import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";
import { startVenueCheck } from "../../../../_lib/venuecheck.js";

export const onRequestPost = ({ params, env }) => handle(async () => {
  const row = await admin(env).requestVenueCheck(String(params.id));
  return json({ ...row, run: await startVenueCheck(env, row.id) });
});
