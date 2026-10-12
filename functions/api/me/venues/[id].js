// PUT /api/me/venues/:id : ajouter une salle du catalogue aux favorites du membre.
// DELETE /api/me/venues/:id : la retirer. Renvoient les identifiants des salles favorites.

import { handle, json } from "../../../_lib/http.js";

export const onRequestPut = ({ params, data }) => handle(async () =>
  json(await data.me.setFavoriteVenue(String(params.id || ""), true)));

export const onRequestDelete = ({ params, data }) => handle(async () =>
  json(await data.me.setFavoriteVenue(String(params.id || ""), false)));
