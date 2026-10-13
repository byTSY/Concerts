// DELETE /api/admin/invitations/:id : supprime un lien d'invitation (il ne fonctionne plus).

import { handle, json } from "../../../../_lib/http.js";
import { admin } from "../../../../_lib/me.js";

export const onRequestDelete = ({ params, env }) => handle(async () => json(await admin(env).deleteInvitation(String(params.id))));
