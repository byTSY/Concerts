// GET /api/admin/venues?status=pending|approved|rejected : salles du catalogue par statut, avec
// le nom affiché du membre qui les a proposées.

import { handle, json } from "../../../_lib/http.js";
import { admin } from "../../../_lib/me.js";

export const onRequestGet = ({ request, env }) => handle(async () =>
  json(await admin(env).venues(new URL(request.url).searchParams.get("status") || "pending")));
