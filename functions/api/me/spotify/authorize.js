// GET /api/me/spotify/authorize : crée un state à usage unique (oauth_states, 10 minutes) avec
// son code_verifier PKCE, puis redirige vers la page d'autorisation de Spotify. Seulement si
// l'admin a ouvert l'accès (ready_to_connect), ou pour reconnecter (revoked, connected, error).

import { randomToken, spotifyAuthorizeUrl, spotifyReady } from "../../../_lib/external.js";
import { HttpError } from "../../../_lib/http.js";
import { tokenKeyReady } from "../../../_lib/tokens.js";

export const callbackUrl = (request) => new URL("/api/me/spotify/callback", request.url).href;

const redirect = (location) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });

// Navigation de page : en cas de refus, retour sur le site avec ?spotify=<code> (account.js)
export const onRequestGet = async ({ request, env, data }) => {
  try {
    if (!spotifyReady(env) || !tokenKeyReady(env)) throw new HttpError(503, "Spotify non configuré", "spotify_unconfigured");
    const state = randomToken(32);
    const verifier = randomToken(48);
    await data.me.startSpotifyAuth({ state, verifier });
    return redirect(await spotifyAuthorizeUrl(env, { state, verifier, redirectUri: callbackUrl(request) }));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(`Autorisation Spotify : ${e?.name || "Error"} ${String(e?.message || "").slice(0, 200)}`);
    return redirect(new URL(`/?spotify=${e instanceof HttpError ? e.code : "error"}`, request.url).href);
  }
};
