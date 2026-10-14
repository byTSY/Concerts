// Vérification automatique d'une salle proposée (version 1.12.0) : lancement du workflow
// venue-check.yml, qui lit la page programme et ajoute la salle au catalogue si la lecture réussit.
// Lancement impossible (GitHub non configuré, refus) : la salle reste à l'admin, avec la raison.

import { dispatchWorkflow } from "./external.js";
import { nowIso } from "./http.js";
import { attempt } from "./outside.js";

export async function startVenueCheck(env, venueId) {
  const run = await attempt(() => dispatchWorkflow(env, "venue-check.yml", { venue: venueId }));
  if (!run.done) {
    const summary = { method: null, url: null, reasons: [`vérification non lancée (${run.reason})`], stats: {}, sample: [] };
    await env.DB.prepare("UPDATE venues SET check_status = 'failed', check_summary = ?, checked_at = ? " +
      "WHERE id = ? AND status = 'pending' AND check_status = 'running'")
      .bind(JSON.stringify(summary), nowIso(), venueId).run();
  }
  return run;
}
