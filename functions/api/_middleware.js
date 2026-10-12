// Seconde barrière (spécification, section 5.1), devant toutes les routes /api/* :
// jeton Access vérifié, membre trouvé dans D1, statut autorisé, rôle admin pour /api/admin/*.
// Le membre connecté est transmis aux routes dans context.data.me (module _lib/me.js).

import { verifyAccess } from "../_lib/access.js";
import { fail, handle, HttpError } from "../_lib/http.js";
import { identify, member } from "../_lib/me.js";

export async function onRequest(context) {
  const { request, env, next, data, waitUntil } = context;
  const path = new URL(request.url).pathname.replace(/\/+$/, "");

  return handle(async () => {
    if (!env.DB || !env.BUCKET) throw new HttpError(503, "base D1 ou stockage R2 non relié au projet", "bindings");
    const { email, iat } = await verifyAccess(request, env);
    const user = await identify(env, email);
    if (!user) return fail(403, "adresse non inscrite", "not_member");
    if (user.status === "suspended") return fail(403, "compte suspendu", "suspended");
    if (path.startsWith("/api/admin") && user.role !== "admin") return fail(403, "réservé à l'admin", "not_admin");

    data.me = member(env, user);
    const write = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    waitUntil(data.me.touch({ iat, write }).catch((e) => console.error(`Activité non enregistrée : ${e?.message}`)));
    return next();
  });
}
