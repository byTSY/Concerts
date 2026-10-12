// DELETE /api/admin/members/:id : suppression complète du membre (données D1 et R2, liste
// Access, sessions).

import { accessListRemove, revokeSessions } from "../../../../_lib/external.js";
import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";
import { attempt } from "../../../../_lib/outside.js";

export const onRequestDelete = ({ params, env }) => handle(async () => {
  const removed = await admin(env).remove(String(params.id));
  const access = await attempt(() => accessListRemove(env, removed.email));
  const sessions = await attempt(() => revokeSessions(env, removed.email));
  return json({ deleted: true, access, sessions });
});
