// Vos préférences : lecture et modification de config/artist_prefs.yaml dans le dépôt GitHub.
//
// GET  /api/prefs  -> { hidden: ["Russ", ...], levels: { "Russ": 3, ... }, starred: { "<id>": "libellé", ... } }
// POST /api/prefs { name, action: "hide" }           -> masque l'artiste
// POST /api/prefs { name, action: "unhide" }         -> ne le masque plus
// POST /api/prefs { name, action: "level", level }   -> impose le niveau 1, 2 ou 3 ; level null : niveau calculé
// POST /api/prefs { id, label, action: "star" }      -> met un concert de côté (« Intéressés »)
// POST /api/prefs { id, action: "unstar" }           -> le retire
// Chaque POST renvoie les préférences à jour.
//
// Variables d'environnement du projet Cloudflare Pages :
//   GITHUB_TOKEN   (secret) jeton GitHub limité au dépôt, droit « Contents : Read and write »
//   GITHUB_REPO    facultatif, « byTSY/Concerts » par défaut
//   GITHUB_BRANCH  facultatif, « main » par défaut
//
// Le site doit être protégé par Cloudflare Access : sans cela, quiconque connaît l'adresse
// pourrait modifier vos préférences.

const PATH = "config/artist_prefs.yaml";

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

function unquote(s) {
  s = s.trim().replace(/\s+#.*$/, "");
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

// Lecture du sous-ensemble YAML écrit par serialize() (et tolérante aux saisies à la main) :
// commentaires d'en-tête, « hidden: » suivi de « - nom », « levels: » suivi de « nom: niveau »,
// « starred: » suivi de « identifiant: libellé »
const SECTIONS = /^(hidden|levels|starred)\s*:\s*(.*)$/;

export function parse(text) {
  const lines = String(text || "").split(/\r?\n/);
  const first = lines.findIndex((l) => SECTIONS.test(l));
  const header = (first < 0 ? lines : lines.slice(0, first)).join("\n").replace(/\s+$/, "");
  const hidden = [], levels = {}, starred = {};
  let section = null;
  for (const l of first < 0 ? [] : lines.slice(first)) {
    const top = l.match(SECTIONS);
    if (top) {
      section = top[1];
      const inline = top[2].replace(/\s+#.*$/, "").trim();
      if (section === "hidden" && inline.startsWith("[") && inline !== "[]") {
        inline.slice(1, -1).split(",").map(unquote).filter(Boolean).forEach((n) => hidden.push(n));
      }
      continue;
    }
    if (/^\S/.test(l)) { section = null; continue; }
    if (section === "hidden") {
      const m = l.match(/^\s*-\s*(.+?)\s*$/);
      if (m && unquote(m[1])) hidden.push(unquote(m[1]));
    } else if (section === "levels") {
      const m = l.match(/^\s+("(?:[^"\\]|\\.)*"|'[^']*'|[^:#]+?)\s*:\s*([123])\s*(#.*)?$/);
      if (m && unquote(m[1])) levels[unquote(m[1])] = Number(m[2]);
    } else if (section === "starred") {
      const m = l.match(/^\s+("[^"]*"|[a-z0-9]+)\s*:\s*(.*?)\s*$/);
      if (m && unquote(m[1])) starred[unquote(m[1])] = unquote(m[2] || "");
    }
  }
  return { header, hidden, levels, starred };
}

export function serialize({ header, hidden, levels, starred = {} }) {
  // Chaînes entre guillemets doubles (JSON), valides en YAML quel que soit le texte
  const q = (s) => JSON.stringify(s);
  const map = (name, obj, fmt) => {
    const keys = Object.keys(obj);
    return keys.length ? `${name}:\n` + keys.map((k) => `  ${q(k)}: ${fmt(obj[k])}`).join("\n") : `${name}: {}`;
  };
  const parts = [
    hidden.length ? "hidden:\n" + hidden.map((n) => `  - ${q(n)}`).join("\n") : "hidden: []",
    map("levels", levels, (v) => v),
    map("starred", starred, q),
  ];
  return (header ? header + "\n\n" : "") + parts.join("\n\n") + "\n";
}

// Applique une action ; renvoie null si rien ne change
export function apply(prefs, { action, name = "", level = null, id = "", label = "" }) {
  const next = { header: prefs.header, hidden: [...prefs.hidden], levels: { ...prefs.levels }, starred: { ...prefs.starred } };
  if (action === "star") {
    if (id in next.starred) return null;  // déjà mis de côté
    next.starred[id] = label;
    return next;
  }
  if (action === "unstar") {
    if (!(id in next.starred)) return null;
    delete next.starred[id];
    return next;
  }
  const key = norm(name);
  // Déjà dans l'état demandé : on n'écrit rien (et on garde la graphie déjà enregistrée)
  const knownHidden = prefs.hidden.find((n) => norm(n) === key);
  const knownLevel = Object.entries(prefs.levels).find(([n]) => norm(n) === key);
  if (action === "hide" && knownHidden) return null;
  if (action === "level" && level && knownLevel && knownLevel[1] === level) return null;
  if (action === "hide" || action === "unhide") {
    next.hidden = prefs.hidden.filter((n) => norm(n) !== key);
    if (action === "hide") next.hidden.push(name);
  }
  if (action === "level") {
    next.levels = Object.fromEntries(Object.entries(prefs.levels).filter(([n]) => norm(n) !== key));
    if (level) next.levels[knownLevel ? knownLevel[0] : name] = level;
  }
  return serialize(next) === serialize(prefs) ? null : next;
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
    write(text, sha, message) {
      return fetch(url, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ message, content: b64encode(text), branch, ...(sha ? { sha } : {}) }),
      });
    },
  };
}

const view = ({ hidden, levels, starred }) => ({ hidden, levels, starred });

export async function onRequestGet({ env }) {
  if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN non configuré dans Cloudflare" }, 503);
  try {
    return json(view(parse((await github(env).read()).text)));
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
  const action = ["hide", "unhide", "level", "star", "unstar"].includes(payload?.action) ? payload.action : null;
  if (!action) return json({ error: "action inconnue" }, 400);
  const req = {
    action,
    name: String(payload?.name ?? "").trim().slice(0, 200),
    level: [1, 2, 3].includes(payload?.level) ? payload.level : null,
    id: String(payload?.id ?? "").trim(),
    label: String(payload?.label ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
  const concert = action === "star" || action === "unstar";
  if (concert && !/^[a-z0-9]{6,40}$/.test(req.id)) return json({ error: "identifiant de concert invalide" }, 400);
  if (!concert && !norm(req.name)) return json({ error: "nom d'artiste manquant" }, 400);
  const { name, level, id, label } = req;

  const gh = github(env);
  // Deux tentatives : si le fichier a changé entre la lecture et l'écriture (HTTP 409), on relit
  for (let attempt = 0; attempt < 2; attempt++) {
    let current;
    try { current = await gh.read(); } catch (e) { return json({ error: e.message }, 502); }
    const prefs = parse(current.text);
    const next = apply(prefs, req);
    if (!next) return json({ ...view(prefs), changed: false });
    const message = {
      hide: `Masquer ${name}`,
      unhide: `Ne plus masquer ${name}`,
      level: level ? `Niveau ${level} pour ${name}` : `Niveau calculé pour ${name}`,
      star: `Intéressé : ${label || id}`,
      unstar: `Plus intéressé : ${prefs.starred[id] || id}`,
    }[action];
    const r = await gh.write(serialize(next), current.sha, `${message} (depuis le site)`);
    if (r.ok) return json({ ...view(next), changed: true });
    if (r.status !== 409 && r.status !== 422) {
      return json({ error: `écriture GitHub impossible (HTTP ${r.status})` }, 502);
    }
  }
  return json({ error: "conflit d'écriture, réessayez" }, 409);
}
