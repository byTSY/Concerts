// Notifications par e-mail (version 1.9.0) : les fonctions ajoutent une ligne à la file D1
// (table notifications), puis lancent le workflow « Notifications » (notify.yml), qui envoie la
// file par SMTP (src/notify.py, où sont rédigés les messages). Un lancement manqué n'est pas
// grave : la file est aussi envoyée à la fin de chaque calcul et par la relance des 2 heures.
//
// Jamais de jeton ni d'identifiant Spotify dans payload. Base sans la migration 0011 : rien
// n'est enregistré, l'action principale n'est pas gênée.

import { dispatchWorkflow } from "./external.js";
import { nowIso } from "./http.js";
import { attempt } from "./outside.js";

// Enregistre le message ; vrai s'il est nouveau (clé dedupe pas encore vue)
export async function queueNotification(env, { kind, userId = null, toAdmin = false, payload = {}, dedupe = null }) {
  try {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO notifications (kind, user_id, to_admin, payload, dedupe_key, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)").bind(kind, userId, toAdmin ? 1 : 0, JSON.stringify(payload), dedupe, nowIso()).run();
    return Boolean(r.meta?.changes);
  } catch (e) {
    console.error(`Notification non enregistrée (${kind}) : ${e?.message}`);
    return false;
  }
}

// Enregistre puis fait envoyer ; à passer à waitUntil (ne retarde pas la réponse)
export async function notify(env, message) {
  if (await queueNotification(env, message)) {
    const r = await attempt(() => dispatchWorkflow(env, "notify.yml"));
    if (r?.done === false) console.log(`Notification ${message.kind} : envoi au prochain traitement (${r.reason})`);
  }
}
