// GET /api/me/spotify/callback?code&state : retour de Spotify après autorisation.
// Le state doit avoir été créé pour le membre connecté (sinon refus) ; il est consommé. Le code
// est échangé côté serveur (secret client, code_verifier) ; seul le jeton de rafraîchissement
// est gardé, chiffré ; le jeton d'accès sert une fois (GET /me) et n'est jamais stocké.
// Compte inconnu de Spotify (403) : retour à la demande en attente, l'admin en est averti.
// Le membre revient sur le site avec ?spotify=<résultat>, affiché par account.js.

import { dispatchRun, spotifyExchange, spotifyMe, spotifyReady } from "../../../_lib/external.js";
import { HttpError } from "../../../_lib/http.js";
import { notify } from "../../../_lib/notify.js";
import { attempt } from "../../../_lib/outside.js";
import { encryptToken, tokenKeyReady } from "../../../_lib/tokens.js";
import { callbackUrl } from "./authorize.js";

const back = (request, result) => new Response(null, {
  status: 302,
  headers: { location: new URL(`/?spotify=${result}`, request.url).href, "cache-control": "no-store" },
});

export const onRequestGet = async ({ request, env, data, waitUntil }) => {
  const url = new URL(request.url);
  try {
    if (!spotifyReady(env) || !tokenKeyReady(env)) throw new HttpError(503, "Spotify non configuré", "spotify_unconfigured");
    const verifier = await data.me.takeSpotifyState(url.searchParams.get("state"));
    if (url.searchParams.get("error")) return back(request, "denied");  // le membre a refusé chez Spotify
    const code = url.searchParams.get("code");
    if (!code || code.length > 1000) throw new HttpError(400, "code absent", "bad_code");
    const tokens = await spotifyExchange(env, { code, verifier, redirectUri: callbackUrl(request) });
    const profile = await spotifyMe(tokens.access);
    if (profile.error === "not_allowlisted") {
      await data.me.spotifyRefused();
      return back(request, "not_allowlisted");
    }
    const id = data.me.user.id;
    await data.me.connectSpotify({
      spotifyId: profile.id, name: profile.name, scopes: tokens.scopes,
      tokenEnc: await encryptToken(env, id, tokens.refresh),
    });
    waitUntil?.(notify(env, { kind: "source_connected", userId: id, toAdmin: true, payload: { provider: "spotify" },
      dedupe: `source:${id}:${new Date().toISOString().slice(0, 16)}` }));
    const run = await attempt(() => dispatchRun(env, id));
    return back(request, run?.done === false ? "ok_later" : "ok");
  } catch (e) {
    if (e instanceof HttpError) return back(request, e.code || "error");
    console.error(`Retour Spotify : ${e?.name || "Error"} ${String(e?.message || "").slice(0, 200)}`);
    return back(request, "error");
  }
};
