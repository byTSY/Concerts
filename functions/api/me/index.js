// GET /api/me : profil, statut, nom affiché, visibilité par défaut des ★, source musicale et
// état de la synchronisation, salles favorites.
// PATCH /api/me { pseudo?, default_visibility? }
// DELETE /api/me { confirm: "SUPPRIMER" } : suppression du compte par le membre (données D1 et
// R2 effacées, adresse retirée de la liste Access, sessions coupées).

import { accessListRemove, revokeSessions } from "../../_lib/external.js";
import { handle, HttpError, json, readJson } from "../../_lib/http.js";
import { attempt } from "../../_lib/outside.js";

export const onRequestGet = ({ data }) => handle(async () => json(await data.me.profile()));

export const onRequestPatch = ({ request, data }) => handle(async () => {
  const body = await readJson(request);
  return json(await data.me.updateProfile({ pseudo: body.pseudo, default_visibility: body.default_visibility }));
});

export const onRequestDelete = ({ request, env, data }) => handle(async () => {
  const body = await readJson(request);
  if (body.confirm !== "SUPPRIMER") throw new HttpError(400, "confirmation manquante");
  if (data.me.user.role === "admin") throw new HttpError(409, "le compte admin ne peut pas être supprimé ici");
  const email = data.me.user.email;
  await data.me.deleteAll();
  const access = await attempt(() => accessListRemove(env, email));
  const sessions = await attempt(() => revokeSessions(env, email));
  return json({ deleted: true, access, sessions });
});
