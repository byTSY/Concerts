// GET /api/me : profil, statut, nom affiché, visibilité par défaut des ★, source musicale et
// état de la synchronisation, salles favorites.
// PATCH /api/me { pseudo?, default_visibility? }
// DELETE /api/me { confirm: "SUPPRIMER" } : suppression du compte par le membre (données D1 et
// R2 effacées, adresse retirée de la liste Access, sessions coupées).

import { accessListRemove, dispatchRun, revokeSessions } from "../../_lib/external.js";
import { handle, HttpError, json, readJson } from "../../_lib/http.js";
import { attempt } from "../../_lib/outside.js";

// Relais : un calcul demandé il y a plus de 15 minutes et resté sans résultat (tâche GitHub
// retardée ou abandonnée) est relancé, sans retarder la réponse
export const onRequestGet = ({ env, data, waitUntil }) => handle(async () => {
  waitUntil((async () => {
    if (await data.me.claimSyncRelay()) {
      const run = await attempt(() => dispatchRun(env, data.me.user.id));
      console.log(`Relais du calcul de ${data.me.user.id} : ${run.done ? "relancé" : run.reason}`);
    }
  })().catch((e) => console.error(`Relais du calcul non fait : ${e?.message}`)));
  return json(await data.me.profile());
});

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
