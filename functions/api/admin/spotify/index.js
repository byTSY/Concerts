// GET /api/admin/spotify : places utilisées sur SPOTIFY_MAX_USERS, demandes à ajouter dans le
// tableau de bord Spotify (nom et e-mail du compte Spotify), membres Spotify, comptes à retirer,
// lien direct vers la page User Management de l'application.

import { spotifyDashboardUrl } from "../../../_lib/external.js";
import { handle, json } from "../../../_lib/http.js";
import { admin } from "../../../_lib/me.js";

export const onRequestGet = ({ env }) => handle(async () =>
  json({ ...(await admin(env).spotify()), dashboard_url: spotifyDashboardUrl(env) }));
