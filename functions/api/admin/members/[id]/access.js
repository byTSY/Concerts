// POST /api/admin/members/:id/access : (re)met l'adresse du membre dans la liste Access des
// membres, après un échec à l'inscription par lien.

import { accessListAdd } from "../../../../_lib/external.js";
import { handle, HttpError, json } from "../../../../_lib/http.js";
import { admin, setAccessPending } from "../../../../_lib/me.js";
import { attempt } from "../../../../_lib/outside.js";

export const onRequestPost = ({ params, env }) => handle(async () => {
  const row = await admin(env).target(String(params.id));
  if (row.status === "suspended") throw new HttpError(409, "membre suspendu : utilisez Réactiver", "suspended");
  const access = await attempt(() => accessListAdd(env, row.email));
  if (access?.done !== false) await setAccessPending(env, row.email, false);
  return json({ access });
});
