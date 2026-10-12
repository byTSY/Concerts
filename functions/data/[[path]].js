// Anciens fichiers personnels du site (avant la reprise, section 14) : retirés du dépôt, mais
// encore gardés en cache par Cloudflare. Cette route répond à leur place ; les fichiers communs
// (events.json, venues.json, meta.json) passent au site statique.

const REMOVED = new Set(["artists.json"]);

export function onRequest({ params, next }) {
  const name = (params.path || []).join("/");
  if (!REMOVED.has(name)) return next();
  return new Response("Fichier retiré", {
    status: 410,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
