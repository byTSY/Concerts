// GET /api/admin/runs : derniers traitements, état des sources, erreurs par membre (codes).
// POST /api/admin/runs : relance du traitement complet.

import { dispatchRun } from "../../_lib/external.js";
import { handle, json } from "../../_lib/http.js";
import { admin } from "../../_lib/me.js";
import { attempt } from "../../_lib/outside.js";

export const onRequestGet = ({ env }) => handle(async () => json(await admin(env).runs()));

export const onRequestPost = ({ env }) => handle(async () => json({ run: await attempt(() => dispatchRun(env, "")) }));
