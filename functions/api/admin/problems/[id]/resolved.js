// POST /api/admin/problems/:id/resolved : signalement traité.

import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";

export const onRequestPost = ({ params, env }) => handle(async () => json(await admin(env).resolveProblem(String(params.id))));
