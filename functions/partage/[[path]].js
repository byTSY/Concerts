// Fiche de partage d'un concert, accessible sans connexion (le reste du site est protégé par
// Cloudflare Access ; seul le chemin /partage/ doit être ouvert à tous).
//
// GET /partage/<id>       -> page web du concert (avec aperçu pour WhatsApp, iMessage…)
// GET /partage/<id>.json  -> informations pour le message : artiste, description, liens
//
// La page ne montre que le concert partagé : rien sur votre liste, vos niveaux ou vos goûts.
// Description de l'artiste : Wikipédia (français, sinon anglais), articles de musiciens seulement.
// Photo et lien de l'artiste : Deezer.

const UA = "concerts-paris (https://github.com/byTSY/Concerts)";
const MUSIC = /musi|chant|groupe|rappeu|rap |compositeu|pianist|guitarist|batteu|saxophon|trompett|dj|producteu|orchestre|ensemble|band|singer|rapper|songwriter|musician|composer|record producer|duo|trio|quartet|jazz|rock|pop|soul|funk|électro|electro|hip-hop|hip hop|chorale|choir/i;
// Pages d'homonymie : « David Walters est un nom de personne notamment porté par… »
const DISAMBIGUATION = /homonymie|nom de personne|notamment porté|peut désigner|est un patronyme|disambiguation|may refer to|can refer to|is the name of/i;
const CACHE_DAYS = 7;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Même normalisation que src/util.py (norm)
export function norm(text) {
  return String(text ?? "").replace(/['’‘`´]/g, " ").normalize("NFKD").replace(/[^\x00-\x7f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim().replace(/^the /, "");
}

// « ANGINE DE POITRINE » -> « Angine De Poitrine » ; les noms déjà en casse mixte sont gardés
export function tidy(s) {
  s = String(s ?? "").trim();
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s\-'’(/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

// Artiste mis en avant : celui de votre liste, la découverte, sinon le titre de la fiche
export function artistOf(ev) {
  if (ev.matched?.length) return { name: ev.matched[0].name, deezer: ev.matched[0].link || null };
  if (ev.discovery?.artist) return { name: ev.discovery.artist, deezer: ev.discovery.link || null, picture: ev.discovery.picture };
  return { name: tidy(ev.artists?.[0] || ev.title), deezer: null };
}

// Première ou deux premières phrases, c. 220 caractères au plus
export function shorten(text, max = 220) {
  const t = String(text || "").replace(/\s+/g, " ").replace(/\s*\([^)]*\)/g, "").trim();
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t];
  let out = "";
  for (const s of sentences) {
    if (out && (out + s).length > max) break;
    out += s;
  }
  out = out.trim() || t;
  return out.length > max + 40 ? out.slice(0, max).replace(/\s+\S*$/, "") + "…" : out;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Article Wikipédia d'un musicien portant ce nom : titre identique, ou « Nom (groupe) », etc.
async function wikipedia(name, lang) {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const search = await getJSON(`${base}?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(name)}`);
  const key = norm(name);
  const titles = (search.query?.search || []).map((h) => h.title)
    .filter((t) => norm(t.replace(/\s*\(.*\)$/, "")) === key);
  for (const title of titles) {
    const data = await getJSON(`${base}?action=query&prop=extracts|pageprops&ppprop=disambiguation&exintro=1&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`);
    const page = Object.values(data.query?.pages || {})[0];
    const extract = page?.extract || "";
    const disambiguation = page?.pageprops?.disambiguation !== undefined || DISAMBIGUATION.test(extract.slice(0, 250));
    if (extract && !disambiguation && MUSIC.test(extract.slice(0, 400))) {
      return { text: shorten(extract), source: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`, lang };
    }
  }
  return null;
}

// Artiste Deezer de même nom (le plus suivi) : lien et photo
async function deezer(name) {
  const data = await getJSON(`https://api.deezer.com/search/artist?limit=10&q=${encodeURIComponent(name)}`);
  const key = norm(name);
  const exact = (data.data || []).filter((a) => norm(a.name) === key).sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0];
  return exact ? { link: exact.link, picture: exact.picture_xl || exact.picture_big || exact.picture_medium } : null;
}

// Description et liens d'un artiste, mis en cache une semaine
async function artistInfo(name, ctx) {
  const cacheKey = new Request(`https://partage.cache/artist/${encodeURIComponent(norm(name))}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const [wiki, dz] = await Promise.all([
    wikipedia(name, "fr").then((r) => r || wikipedia(name, "en")).catch(() => null),
    deezer(name).catch(() => null),
  ]);
  const info = { description: wiki?.text || null, descriptionSource: wiki?.source || null, deezer: dz?.link || null, picture: dz?.picture || null };
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(info), {
    headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_DAYS * 86400}` },
  })));
  return info;
}

// Familles de styles : mêmes règles que le site (site/app.js)
const STYLES = [
  ["jazz, blues, soul", /jazz|blues|soul|funk|gospel|swing|manouche/],
  ["rap, R&B", /\brap\b|hip hop|urbain|\br b\b|\brnb\b/],
  ["pop, rock", /\bpop\b|rock|punk|folk|alternative|indie|country|variete internationale/],
  ["électro", /electro|\bdance\b|techno|house/],
  ["metal", /metal|hardcore/],
  ["chanson française", /chanson|variete francaise|french/],
  ["musiques du monde", /monde|world|oriental|reggae|bresil|latin|salsa|samba|afri|flamenco|klezmer|indienne|andalouse|caribeen|traditionnel/],
  ["classique", /classi|symphoni|chambre|baroque|lyrique|opera|sacree|religious|orgue|romantique|piano|violon|eglise|contemporain|medieval|noel|bougie/],
];

export function styleOf(ev) {
  const g = norm(ev.genre || "");
  const found = STYLES.filter(([, re]) => re.test(g)).map(([label]) => label);
  return found.slice(0, 2).join(" et ") || null;
}

export async function concertInfo(ev, ctx) {
  const artist = artistOf(ev);
  const info = await artistInfo(artist.name, ctx);
  const q = encodeURIComponent(artist.name);
  return {
    id: ev.id,
    artist: artist.name,
    title: tidy(ev.title),
    date: ev.date,
    time: ev.time || null,
    venue: tidy(ev.venue),
    address: [ev.address, ev.city].filter(Boolean).join(", ") || null,
    price: ev.price || null,
    onSale: ev.on_sale || null,
    status: ev.status || null,
    style: styleOf(ev),
    genre: ev.genre || null,
    description: info.description,
    descriptionSource: info.descriptionSource,
    picture: artist.picture || info.picture || ev.image || null,
    tickets: (ev.links || []).map((l) => ({ source: l.source, url: l.url })),
    listen: {
      deezer: artist.deezer || info.deezer || `https://www.deezer.com/search/${q}`,
      spotify: `https://open.spotify.com/search/${q}`,
      youtube: `https://www.youtube.com/results?search_query=${q}`,
    },
  };
}

const fmtDate = (iso) => new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
  .format(new Date(iso + "T12:00:00Z"));

export function page(c, url) {
  const when = `${fmtDate(c.date)}${c.time ? ` à ${c.time.replace(/^(\d+):(\d+)$/, (m, h, mn) => `${Number(h)}h${mn === "00" ? "" : mn}`)}` : ""}`;
  const desc = c.description || [c.style && `Concert ${c.style}`, `${when}, ${c.venue}`].filter(Boolean).join(" · ");
  const tickets = c.tickets.map((t) => `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Billets sur ${esc(t.source)}</a>`).join("");
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.artist)} · ${esc(when)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(c.artist)} · ${esc(c.venue)}">
<meta property="og:description" content="${esc(when)}${c.style ? ` · ${esc(c.style)}` : ""}">
${c.picture ? `<meta property="og:image" content="${esc(c.picture)}">` : ""}
<meta property="og:url" content="${esc(url)}">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,300..800&display=swap" rel="stylesheet">
<style>
  :root { --paper: #e9ebef; --paper-2: #f6f7f9; --ink: #1e2350; --ink-soft: #565b78; --rule: #c9ccd6; --blue: #0078bf; --pink: #ff48b0; --yellow: #ffe800; }
  @media (prefers-color-scheme: dark) { :root { --paper: #171b3a; --paper-2: #20254a; --ink: #eef0f7; --ink-soft: #a9aecb; --rule: #343a66; --blue: #3fa3e8; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: "Bricolage Grotesque", "Helvetica Neue", Arial, sans-serif; line-height: 1.5; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  .card { background: var(--paper-2); border-radius: 14px; overflow: hidden; box-shadow: 0 6px 24px rgb(0 0 0 / .12); }
  .hero { position: relative; aspect-ratio: 16 / 10; background: var(--blue) center / cover no-repeat; }
  .hero::after { content: ""; position: absolute; inset: 0; background: linear-gradient(transparent 45%, rgb(0 0 0 / .65)); }
  .hero h1 { position: absolute; left: 20px; right: 20px; bottom: 14px; z-index: 1; margin: 0; color: #fff;
    font-size: clamp(2rem, 7vw, 3.2rem); font-weight: 800; font-stretch: 80%; line-height: 1.02; }
  .body { padding: 20px; }
  .when { display: flex; gap: 14px; align-items: center; }
  .stub { flex: none; width: 74px; text-align: center; background: var(--pink); color: #fff; border-radius: 8px; padding: 8px 4px; }
  .stub b { display: block; font-size: 2rem; line-height: 1; font-stretch: 75%; }
  .stub span { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  .when p { margin: 0; }
  .when .date { font-weight: 700; font-size: 1.1rem; }
  .when .venue { color: var(--ink-soft); }
  .tags { margin: 16px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .tag { font-size: .82rem; padding: 2px 10px; border-radius: 99px; background: var(--paper); border: 1px solid var(--rule); }
  .about { margin: 20px 0 0; font-size: 1.02rem; }
  .source { font-size: .8rem; color: var(--ink-soft); }
  .source a { color: inherit; }
  h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-soft); margin: 24px 0 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn { display: inline-block; padding: 10px 16px; border-radius: 8px; font-weight: 600; text-decoration: none; background: var(--ink); color: var(--paper-2); }
  .btn.out { background: none; color: var(--ink); border: 1.5px solid var(--rule); }
  footer { text-align: center; color: var(--ink-soft); font-size: .8rem; margin-top: 18px; }
</style>
</head>
<body>
<main>
  <article class="card">
    <div class="hero" style="${c.picture ? `background-image:url('${esc(c.picture)}')` : ""}"><h1>${esc(c.artist)}</h1></div>
    <div class="body">
      <div class="when">
        <div class="stub"><b>${Number(c.date.slice(8, 10))}</b><span>${esc(new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: "UTC" }).format(new Date(c.date + "T12:00:00Z")))}</span></div>
        <div>
          <p class="date">${esc(when.charAt(0).toUpperCase() + when.slice(1))}</p>
          <p class="venue">${esc(c.venue)}${c.address ? `, ${esc(c.address)}` : ""}</p>
        </div>
      </div>
      <div class="tags">
        ${c.genre || c.style ? `<span class="tag">${esc(c.genre || c.style)}</span>` : ""}
        ${c.price ? `<span class="tag">${esc(c.price)}</span>` : ""}
        ${c.title && norm(c.title) !== norm(c.artist) ? `<span class="tag">${esc(c.title)}</span>` : ""}
      </div>
      ${c.description ? `<p class="about">${esc(c.description)}</p>
      <p class="source">Source : <a href="${esc(c.descriptionSource)}" target="_blank" rel="noopener">Wikipédia</a></p>` : ""}
      ${tickets ? `<h2>Places</h2><div class="row">${tickets}</div>` : ""}
      <h2>Écouter</h2>
      <div class="row">
        <a class="btn out" href="${esc(c.listen.deezer)}" target="_blank" rel="noopener">Deezer</a>
        <a class="btn out" href="${esc(c.listen.spotify)}" target="_blank" rel="noopener">Spotify</a>
        <a class="btn out" href="${esc(c.listen.youtube)}" target="_blank" rel="noopener">YouTube</a>
      </div>
    </div>
  </article>
  <footer>Partagé depuis Concerts à Paris</footer>
</main>
</body>
</html>`;
}

function notFound() {
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Concert introuvable</title><meta name="robots" content="noindex"></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5">
<h1>Concert introuvable</h1><p>Ce concert est passé ou n'est plus à l'affiche.</p></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const waitUntil = (p) => context.waitUntil(p);
  const raw = (params.path || []).join("/");
  const asJson = raw.endsWith(".json");
  const id = raw.replace(/\.json$/, "");
  if (!/^[a-z0-9]{6,40}$/.test(id)) return notFound();

  // Données publiées, lues directement dans le site (sans passer par la protection d'accès)
  const assets = await env.ASSETS.fetch(new URL("/data/events.json", request.url));
  if (!assets.ok) return new Response("Données indisponibles", { status: 503 });
  const ev = (await assets.json()).find((e) => e.id === id);
  if (!ev) return asJson ? new Response(JSON.stringify({ error: "concert introuvable" }), { status: 404 }) : notFound();

  const info = await concertInfo(ev, { waitUntil });
  if (asJson) {
    return new Response(JSON.stringify(info), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(page(info, request.url), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
