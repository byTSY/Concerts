// POST /api/me/source/deezer { profile } : lien ou n° de profil Deezer ; vérifie qu'il est
// public et libre, renvoie un aperçu (nom, photo, nombre d'artistes favoris) à confirmer.

import { deezerProfile, deezerProfileId } from "../../../../_lib/external.js";
import { handle, HttpError, json, readJson } from "../../../../_lib/http.js";

export async function preview(request, data) {
  const body = await readJson(request);
  const id = await deezerProfileId(body.profile);
  if (!id) throw new HttpError(400, "collez le lien de votre profil Deezer ou son n°", "bad_profile");
  return data.me.checkDeezer(id, await deezerProfile(id));
}

export const onRequestPost = ({ request, data }) => handle(async () => json(await preview(request, data)));
