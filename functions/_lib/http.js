// Réponses JSON et lecture des requêtes, communes aux fonctions /api/*.

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export const fail = (status, error, code) => json({ error, ...(code ? { code } : {}) }, status);

// Corps JSON obligatoire pour les écritures : un autre site ne peut pas envoyer une telle requête
// sans autorisation préalable (CORS)
export async function readJson(request) {
  if (!(request.headers.get("content-type") || "").includes("application/json")) {
    throw new HttpError(415, "requête JSON attendue");
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "JSON invalide");
  }
}

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Exécute un gestionnaire de route ; une HttpError devient une réponse d'erreur, le reste un 500
// sans détail (le détail reste dans les journaux, sans donnée personnelle)
export async function handle(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.message, e.code);
    console.error(`Erreur : ${e?.name || "Error"} ${e?.message || ""}`);
    return fail(500, "erreur interne");
  }
}

// Même normalisation que src/util.py (norm) : accents, apostrophes, ponctuation, « the » initial
export function norm(text) {
  return String(text ?? "")
    .replace(/['’‘`´]/g, " ")
    .normalize("NFKD").replace(/[^\x00-\x7f]/g, "")
    .toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^the /, "");
}

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
