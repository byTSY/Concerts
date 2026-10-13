// POST /api/admin/venues/:id/reject { note? } : proposition refusée, avec une note facultative
// que le membre voit dans ses propositions.

import { handle, json, readJson } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";

// Corps JSON facultatif : { note }
export async function optionalNote(request) {
  if (!(request.headers.get("content-type") || "").includes("application/json")) return null;
  return (await readJson(request)).note ?? null;
}

export const onRequestPost = ({ request, params, env }) => handle(async () =>
  json(await admin(env).reviewVenue(String(params.id), "rejected", await optionalNote(request))));
