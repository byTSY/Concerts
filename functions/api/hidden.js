// Artistes masqués : lecture et modification de config/hidden_artists.yaml dans le dépôt GitHub.
//
// GET  /api/hidden                          -> { hidden: ["Michel", ...] }
// POST /api/hidden { name, action }         -> action "hide" ou "unhide", renvoie la liste à jour
//
// Variables d'environnement du projet Cloudflare Pages :
//   GITHUB_TOKEN   (secret) jeton GitHub limité au dépôt, droit « Contents : Read and write »
//   GITHUB_REPO    facultatif, « byTSY/Concerts » par défaut
//   GITHUB_BRANCH  facultatif, « main » par défaut
//
// Le site doit être protégé par Cloudflare Access : sans cela, quiconque connaît l'adresse
// pourrait modifier la liste.

const PATH = "config/hidden_artists.yaml";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// Même normalisation que src/util.py (norm) : accents, apostrophes, ponctuation, « the » initial
export function norm(text) {
  return String(text ?? "")
    .replace(/['’‘`´]/g, " ")
    .normalize("NFKD").replace(/[^\x00-\x7f]/g, "")
    .toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^the /, "");
}

// Lecture tolérante du fichier : commentaires d'en-tête, puis « hidden: » et une ligne « - nom » par artiste
export function parse(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^hidden\s*:/.test(l));
  const header = (start < 0 ? lines : lines.slice(0, start)).join("\n").replace(/\s+$/, "");
  const names = [];
  if (start >= 0) {
    const inline = lines[start].replace(/^hidden\s*:\s*/, "").trim();
    if (inline.startsWith("[") && inline !== "[]") {
      inline.slice(1, -1).split(",").forEach((s) => names.push(unquote(s.trim())));
    }
    for (const l of lines.slice(start + 1)) {
      const m = l.match(/^\s*-\s*(.+?)\s*$/);
      if (m) names.push(unquote(m[1]));
      else if (/^\S/.test(l)) break;
    }
  }
  return { header, names: names.filter(Boolean) };
}

function unquote(s) {
  s = s.replace(/\s+#.*$/, "");
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function serialize(header, names) {
  // Chaînes entre guillemets doubles (JSON), valides en YAML quel que soit le nom
  const body = names.length ? "hidden:\n" + names.map((n) => `  - ${JSON.stringify(n)}`).join("\n") : "hidden: []";
  return (header ? header + "\n\n" : "") + body + "\n";
}

const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
const b64encode = (s) => {
  let bin = "";
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte);
  return btoa(bin);
};

function github(env) {
  const repo = env.GITHUB_REPO || "byTSY/Concerts";
  const branch = env.GITHUB_BRANCH || "main";
  const url = `https://api.github.com/repos/${repo}/contents/${PATH}`;
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "concerts-paris",
    "x-github-api-version": "2022-11-28",
  };
  return {
    async read() {
      const r = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
      if (r.status === 404) return { sha: null, text: "" };
      if (!r.ok) throw new Error(`lecture GitHub impossible (HTTP ${r.status})`);
      const data = await r.json();
      return { sha: data.sha, text: b64decode(data.content) };
    },
    async write(text, sha, message) {
      const r = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ message, content: b64encode(text), branch, ...(sha ? { sha } : {}) }),
      });
      return r;
    },
  };
}

export async function onRequestGet({ env }) {
  if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN non configuré dans Cloudflare" }, 503);
  try {
    const { text } = await github(env).read();
    return json({ hidden: parse(text).names });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN non configuré dans Cloudflare" }, 503);
  // Requête JSON uniquement : un autre site ne peut pas l'envoyer sans autorisation préalable (CORS)
  if (!(request.headers.get("content-type") || "").includes("application/json")) {
    return json({ error: "requête JSON attendue" }, 415);
  }
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "JSON invalide" }, 400); }
  const name = String(payload?.name ?? "").trim().slice(0, 200);
  const action = payload?.action === "unhide" ? "unhide" : "hide";
  if (!name || !norm(name)) return json({ error: "nom d'artiste manquant" }, 400);

  const gh = github(env);
  // Deux tentatives : si le fichier a changé entre la lecture et l'écriture (HTTP 409), on relit
  for (let attempt = 0; attempt < 2; attempt++) {
    let current;
    try { current = await gh.read(); } catch (e) { return json({ error: e.message }, 502); }
    const { header, names } = parse(current.text);
    const key = norm(name);
    const present = names.some((n) => norm(n) === key);
    let next = names;
    if (action === "hide" && !present) next = [...names, name];
    if (action === "unhide") next = names.filter((n) => norm(n) !== key);
    if (next.length === names.length) return json({ hidden: names, changed: false });  // déjà à jour
    const verb = action === "hide" ? "Masquer" : "Ne plus masquer";
    const r = await gh.write(serialize(header, next), current.sha, `${verb} ${name} (depuis le site)`);
    if (r.ok) return json({ hidden: next, changed: true });
    if (r.status !== 409 && r.status !== 422) {
      return json({ error: `écriture GitHub impossible (HTTP ${r.status})` }, 502);
    }
  }
  return json({ error: "conflit d'écriture, réessayez" }, 409);
}
