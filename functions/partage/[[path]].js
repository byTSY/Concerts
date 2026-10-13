// Fiche de partage d'un concert, accessible sans connexion (le reste du site est protégé par
// Cloudflare Access ; seul le chemin /partage/ doit être ouvert à tous).
//
// GET /partage/<id>       -> page web du concert (avec aperçu pour WhatsApp, iMessage…)
// GET /partage/<id>.json  -> informations pour le message : artiste, description, liens
//
// La page ne montre que le concert partagé : rien sur votre liste, vos niveaux ou vos goûts.
// Description de l'artiste, toujours en français et centrée sur la musique :
// - Wikidata : description courte (« groupe de rock anglais ») et genres musicaux ;
// - Deezer : photo, lien et artistes similaires (« dans la veine de… »).

const UA = "concerts-paris (https://github.com/byTSY/Concerts)";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
// Une fiche Wikidata d'artiste musical porte un identifiant Deezer, Discogs, MusicBrainz, Spotify,
// Apple Music, AllMusic ou Last.fm ; cela écarte les homonymes (nageur, politicien, film…).
// Le genre (P136) ne suffit pas : les films et les livres en ont aussi.
const MUSIC_PROPS = ["P2722", "P1953", "P434", "P1902", "P2850", "P1728", "P3192"];
const MUSIC_JOBS = ["Q177220", "Q639669", "Q2252262", "Q488205", "Q130857", "Q36834", "Q183945", "Q855091", "Q486748",
  "Q386854", "Q12800682", "Q12377274", "Q584301", "Q15981151", "Q753110", "Q1327329"];
const isMusical = (e) => MUSIC_PROPS.some((p) => e.claims?.[p]?.length) || claimIds(e, "P106").some((id) => MUSIC_JOBS.includes(id));
const CACHE_DAYS = 7;
const DICE_TIMEOUT_MS = 4000;  // une page Dice lente ne retarde pas le reste de la fiche

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Lien externe venu des sources : http(s) seulement ; image : adresse encodée pour url("…")
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "").trim()) ? String(u).trim() : "#");
const cssUrl = (u) => (/^https:\/\//i.test(String(u ?? "")) ? String(u).replace(/["'()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`) : "");

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

// Les concerts publiés ne disent plus quel artiste de la programmation intéresse chaque membre :
// le lien de partage le précise (?a=<nom>&dz=<identifiant Deezer>). Le nom n'est retenu que s'il
// figure dans la programmation ou le titre du concert.
export function withSharedArtist(ev, params) {
  const name = String(params.get("a") || "").trim().slice(0, 120);
  const key = norm(name);
  if (!key || ev.matched?.length) return ev;
  const listed = (ev.artists || []).some((a) => norm(a) === key) || ` ${norm(ev.title)} `.includes(` ${key} `);
  if (!listed) return ev;
  const dz = /^\d{1,12}$/.test(params.get("dz") || "") ? params.get("dz") : null;
  return { ...ev, matched: [{ name, link: dz ? `https://www.deezer.com/artist/${dz}` : null }] };
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const listFr = (a) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} et ${a.at(-1)}` : a[0] || "");

// « du rock psychédélique », « de la dream pop », « de l'indie rock », « du hip-hop »
const FEMININE_HEAD = /^(pop|soul|house|techno|musique|chanson|variete|salsa|samba|bossa|cumbia|rumba|bachata|electro|disco|dance|trap|drill|jungle|synthpop|new wave|world music)/;
const FEMININE_TAIL = /\b(pop|soul|house|techno|wave|disco|trap|drill|dance)$/;
export function withArticle(genre) {
  const n = norm(genre);
  const feminine = FEMININE_HEAD.test(n) || FEMININE_TAIL.test(n);
  if (/^[aeiouy]/.test(n)) return `de l'${genre}`;  // le h est aspiré : « du hip-hop », « de la house »
  return `${feminine ? "de la" : "du"} ${genre}`;
}

// Repli quand Wikidata n'a pas de description en français : métier et pays
const OCCUPATIONS = [
  ["Q2252262", "rappeur", "rappeuse"], ["Q488205", "auteur-compositeur-interprète", "autrice-compositrice-interprète"],
  ["Q177220", "chanteur", "chanteuse"], ["Q130857", "DJ", "DJ"], ["Q183945", "producteur", "productrice"],
  ["Q15981151", "musicien de jazz", "musicienne de jazz"], ["Q12800682", "saxophoniste", "saxophoniste"],
  ["Q12377274", "trompettiste", "trompettiste"], ["Q855091", "guitariste", "guitariste"], ["Q486748", "pianiste", "pianiste"],
  ["Q386854", "batteur", "batteuse"], ["Q584301", "bassiste", "bassiste"], ["Q36834", "compositeur", "compositrice"],
  ["Q639669", "musicien", "musicienne"],
];
const COUNTRIES = {
  Q142: ["français", "française"], Q145: ["britannique", "britannique"], Q21: ["anglais", "anglaise"], Q22: ["écossais", "écossaise"],
  Q30: ["américain", "américaine"], Q16: ["canadien", "canadienne"], Q31: ["belge", "belge"], Q183: ["allemand", "allemande"],
  Q408: ["australien", "australienne"], Q27: ["irlandais", "irlandaise"], Q38: ["italien", "italienne"], Q29: ["espagnol", "espagnole"],
  Q55: ["néerlandais", "néerlandaise"], Q29999: ["néerlandais", "néerlandaise"], Q34: ["suédois", "suédoise"], Q20: ["norvégien", "norvégienne"],
  Q35: ["danois", "danoise"], Q17: ["japonais", "japonaise"], Q155: ["brésilien", "brésilienne"], Q1033: ["nigérian", "nigériane"],
  Q117: ["ghanéen", "ghanéenne"], Q766: ["jamaïcain", "jamaïcaine"], Q912: ["malien", "malienne"], Q1041: ["sénégalais", "sénégalaise"],
  Q241: ["cubain", "cubaine"], Q884: ["sud-coréen", "sud-coréenne"], Q39: ["suisse", "suisse"], Q96: ["mexicain", "mexicaine"],
  Q414: ["argentin", "argentine"], Q189: ["islandais", "islandaise"], Q33: ["finlandais", "finlandaise"], Q45: ["portugais", "portugaise"],
  Q262: ["algérien", "algérienne"], Q1028: ["marocain", "marocaine"], Q948: ["tunisien", "tunisienne"], Q1009: ["camerounais", "camerounaise"],
  Q1008: ["ivoirien", "ivoirienne"], Q974: ["congolais", "congolaise"], Q258: ["sud-africain", "sud-africaine"], Q664: ["néo-zélandais", "néo-zélandaise"],
  Q801: ["israélien", "israélienne"], Q822: ["libanais", "libanaise"], Q36: ["polonais", "polonaise"], Q159: ["russe", "russe"],
  Q212: ["ukrainien", "ukrainienne"], Q739: ["colombien", "colombienne"], Q40: ["autrichien", "autrichienne"], Q790: ["haïtien", "haïtienne"],
};

// Genres Wikidata utilisables : pas de notion qui n'est pas un genre (« composition de musique
// instrumentale »), et le plus précis seulement (« hard rock » plutôt que « rock et hard rock »)
const NOT_A_GENRE = /composition|instrument|chanson a texte|musique vocale|^musique$|^chanson$/;
export function cleanGenres(labels) {
  const ok = labels.filter((g) => g.length <= 30 && !NOT_A_GENRE.test(norm(g)));
  const specific = ok.filter((g) => !ok.some((o) => o !== g && ` ${norm(o)} `.includes(` ${norm(g)} `)));
  return [...new Set(specific)].slice(0, 2);
}

const claimIds = (entity, prop) => (entity?.claims?.[prop] || [])
  .map((c) => c.mainsnak?.datavalue?.value).map((v) => (v && typeof v === "object" ? v.id : v)).filter(Boolean);

function builtDescription(e) {
  const female = claimIds(e, "P21").some((id) => id === "Q6581072" || id === "Q1052281");
  const human = claimIds(e, "P31").includes("Q5");
  const country = COUNTRIES[claimIds(e, human ? "P27" : "P495")[0]] || COUNTRIES[claimIds(e, "P27")[0]];
  const occ = claimIds(e, "P106");
  const job = human ? OCCUPATIONS.find(([id]) => occ.includes(id)) : null;
  const who = human ? (job ? job[female ? 2 : 1] : null) : claimIds(e, "P31").includes("Q9212979") ? "duo" : "groupe";
  if (!who) return null;
  return country ? `${who} ${country[human && female ? 1 : 0]}` : who;
}

// Fiche Wikidata de l'artiste : description courte en français et genres musicaux
async function wikidata(name, deezerId) {
  const search = await getJSON(`${WIKIDATA}?action=wbsearchentities&format=json&language=fr&uselang=fr&type=item&limit=7&search=${encodeURIComponent(name)}`);
  const key = norm(name);
  const ids = (search.search || []).filter((h) => norm(h.label) === key || norm(h.match?.text) === key).map((h) => h.id).slice(0, 6);
  if (!ids.length) return null;
  const data = await getJSON(`${WIKIDATA}?action=wbgetentities&format=json&props=claims|descriptions|sitelinks&languages=fr&sitefilter=frwiki&ids=${ids.join("|")}`);
  const list = ids.map((id) => data.entities?.[id]).filter(Boolean);
  // L'identifiant Deezer tranche ; sinon la première fiche d'artiste musical, à condition qu'elle
  // ne porte pas l'identifiant Deezer d'un autre artiste
  const sameDeezer = (e) => claimIds(e, "P2722").map(String).includes(String(deezerId));
  const otherDeezer = (e) => deezerId && claimIds(e, "P2722").length && !sameDeezer(e);
  const pick = (deezerId && list.find(sameDeezer)) || list.find((e) => isMusical(e) && !otherDeezer(e));
  if (!pick) return null;
  const genreIds = claimIds(pick, "P136").slice(0, 4);
  let genres = [];
  if (genreIds.length) {
    const labels = await getJSON(`${WIKIDATA}?action=wbgetentities&format=json&props=labels&languages=fr&ids=${genreIds.join("|")}`);
    genres = cleanGenres(genreIds.map((id) => labels.entities?.[id]?.labels?.fr?.value).filter(Boolean));
  }
  const wikiTitle = pick.sitelinks?.frwiki?.title;
  return {
    description: pick.descriptions?.fr?.value || builtDescription(pick),
    genres,
    spotifyId: claimIds(pick, "P1902")[0] || null,  // identifiant d'artiste Spotify
    source: wikiTitle ? `https://fr.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, "_"))}` : `https://www.wikidata.org/wiki/${pick.id}`,
  };
}

// Artiste Deezer (identifiant connu, sinon homonyme exact le plus suivi) : lien, photo, similaires
async function deezer(name, knownId) {
  let artist = null;
  if (knownId) {
    artist = await getJSON(`https://api.deezer.com/artist/${knownId}`);
    // Identifiant venu du lien de partage : écarté s'il désigne un autre artiste (le résultat est
    // mis en cache sous le nom pour une semaine)
    if (artist?.error || norm(artist?.name) !== norm(name)) artist = null;
  }
  if (!artist) {
    const data = await getJSON(`https://api.deezer.com/search/artist?limit=10&q=${encodeURIComponent(name)}`);
    artist = (data.data || []).filter((a) => norm(a.name) === norm(name)).sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0] || null;
  }
  if (!artist) return null;
  const related = await getJSON(`https://api.deezer.com/artist/${artist.id}/related?limit=6`).catch(() => ({}));
  return {
    id: artist.id,
    link: artist.link,
    picture: artist.picture_xl || artist.picture_big || artist.picture_medium,
    similar: (related.data || []).map((a) => a.name).filter((n) => norm(n) !== norm(name)).slice(0, 3),
  };
}

// --- Spotify ---------------------------------------------------------------------
// Lien exact de l'artiste : identifiant Spotify de Wikidata ; à défaut, API Spotify si les clés
// SPOTIFY_CLIENT_ID et SPOTIFY_CLIENT_SECRET sont renseignées dans Cloudflare ; sinon recherche.

async function spotifyToken(env) {
  const key = new Request("https://partage.cache/spotify/token");
  const hit = await caches.default.match(key);
  if (hit) return (await hit.json()).token;
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`Spotify HTTP ${r.status}`);
  const data = await r.json();
  await caches.default.put(key, new Response(JSON.stringify({ token: data.access_token }), {
    headers: { "cache-control": `max-age=${Math.max(60, (data.expires_in || 3600) - 120)}` },
  }));
  return data.access_token;
}

async function spotifyArtist(name, env) {
  if (!env?.SPOTIFY_CLIENT_ID || !env?.SPOTIFY_CLIENT_SECRET) return null;
  const token = await spotifyToken(env);
  const r = await fetch(`https://api.spotify.com/v1/search?type=artist&limit=10&q=${encodeURIComponent(name)}`,
    { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Spotify HTTP ${r.status}`);
  const items = ((await r.json()).artists?.items || []).filter((a) => norm(a.name) === norm(name));
  items.sort((a, b) => (b.followers?.total || 0) - (a.followers?.total || 0) || (b.popularity || 0) - (a.popularity || 0));
  return items[0]?.id || null;
}

// --- Dice : présentation rédigée par l'organisateur ------------------------------------

// Texte du bloc JSON-LD de l'événement (objet, liste ou @graph) ; à défaut, aperçu og:description
// (tronqué par Dice, mais mieux que rien si la page change de structure)
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", hellip: "…",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç", ocirc: "ô", ucirc: "û", icirc: "î" };
const unescapeHtml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
  const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : m;
});
const isEvent = (d) => [].concat(d?.["@type"] || []).some((t) => /Event/.test(t));

export function diceText(html) {
  let text = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }  // bloc illisible
    const nodes = [].concat(data || []).flatMap((d) => [d, ...[].concat(d?.["@graph"] || [])]);
    const ev = nodes.find((d) => isEvent(d) && typeof d.description === "string" && d.description.trim());
    if (ev) { text = ev.description; break; }
  }
  if (!text) {
    const meta = html.match(/<meta[^>]+property=["']og:description["'][^>]*>/i)?.[0];
    text = meta?.match(/content=(["'])([\s\S]*?)\1/i)?.[2] || null;
  }
  text = unescapeHtml(text || "").replace(/\s*\n\s*/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!text) return null;
  return text.length > 600 ? text.slice(0, 600).replace(/\s+\S*$/, "") + "…" : text;
}

// { text, ok } : ok faux quand la page n'a pas pu être lue (erreur, délai dépassé) ; le résultat
// n'est alors pas gardé en cache, pour réessayer à la visite suivante
export async function diceDescription(url) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(DICE_TIMEOUT_MS) });
    if (!r.ok) { await r.body?.cancel(); return { text: null, ok: false }; }
    return { text: diceText(await r.text()), ok: true };
  } catch {
    return { text: null, ok: false };
  }
}

// Description, style et liens d'un artiste, mis en cache une semaine
async function artistInfo(name, deezerLink, ctx) {
  const cacheKey = new Request(`https://partage.cache/v5/artist/${encodeURIComponent(norm(name))}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const knownId = (String(deezerLink || "").match(/artist\/(\d+)/) || [])[1];
  const dz = await deezer(name, knownId).catch(() => null);
  const wd = await wikidata(name, dz?.id).catch(() => null);
  const spotifyId = wd?.spotifyId || await spotifyArtist(name, ctx.env).catch(() => null);
  const who = cap(wd?.description || "");
  const similar = dz?.similar || [];
  // « Groupe de rock anglais, dans la veine de Tame Impala, Pond et Jacco Gardner. »
  const summary = who && similar.length ? `${who}, dans la veine de ${listFr(similar)}.`
    : who ? `${who}.` : similar.length ? `Dans la veine de ${listFr(similar)}.` : null;
  const info = {
    summary,
    genres: wd?.genres || [],
    styleText: wd?.genres?.length ? withArticle(wd.genres[0]) : null,  // un seul genre dans le message
    source: wd?.source || null,
    deezer: dz?.link || null,
    spotify: spotifyId ? `https://open.spotify.com/artist/${spotifyId}` : null,
    picture: dz?.picture || null,
  };
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

// Genre lisible : « Pop, Pop / Rock » -> « Pop » ; « Église, Classique » -> « Classique »
// (L'Officiel des spectacles donne le sous-genre puis la famille, parfois un lieu ou un instrument)
const NOT_GENRE = /^(eglise|piano|violon|orgue|guitare|concert a la bougie|concert de noel|choix de la redaction|music|other|undefined)$/;
export function displayGenre(genre) {
  const parts = String(genre || "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts.find((p) => !NOT_GENRE.test(norm(p))) || null;
}

export function styleOf(ev) {
  const g = norm(ev.genre || "");
  const found = STYLES.filter(([, re]) => re.test(g)).map(([label]) => label);
  return found.slice(0, 2).join(" et ") || null;
}

// Présentation Dice d'un concert : une semaine en cache si elle existe, un jour si la page n'en a
// pas (structure changée, texte ajouté plus tard), pas de cache si la page n'a pas pu être lue.
// Clé « dice2 » : abandonne les résultats vides gardés une semaine par l'ancienne version.
async function organizerText(ev, ctx) {
  const dice = (ev.links || []).find((l) => l.source === "Dice");
  if (!dice) return null;
  const key = new Request(`https://partage.cache/dice2/${encodeURIComponent(dice.url)}`);
  const hit = await caches.default.match(key);
  if (hit) return (await hit.json()).text;
  const { text, ok } = await diceDescription(dice.url);
  if (!ok) ctx.diceFailed = true;  // page /partage/ alors non gardée en cache
  if (ok) {
    ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify({ text }), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${(text ? CACHE_DAYS : 1) * 86400}` },
    })));
  }
  return text;
}

export async function concertInfo(ev, ctx) {
  const artist = artistOf(ev);
  const [info, organizer] = await Promise.all([artistInfo(artist.name, artist.deezer, ctx), organizerText(ev, ctx)]);
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
    genre: displayGenre(ev.genre),
    description: info.summary,
    styleText: info.styleText,
    genres: info.genres,
    descriptionSource: info.source,
    picture: artist.picture || info.picture || ev.image || null,
    organizer,  // présentation rédigée par l'organisateur sur Dice
    tickets: (ev.links || []).map((l) => ({ source: l.source, url: l.url })),
    // Fnac Spectacles bloque la lecture automatique : simple lien de recherche sur l'artiste
    fnac: `https://www.fnacspectacles.com/search/?searchterm=${q}`,
    listen: {
      deezer: artist.deezer || info.deezer || `https://www.deezer.com/search/${q}`,
      spotify: info.spotify || `https://open.spotify.com/search/${q}`,
      spotifyExact: Boolean(info.spotify),
      youtube: `https://www.youtube.com/results?search_query=${q}`,
    },
  };
}

const fmtDate = (iso) => new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
  .format(new Date(iso + "T12:00:00Z"));

// Lien de la newsletter (?app=1) : « Ouvrir dans l'app » et « Ajouter à mes Intéressés »
// (connexion demandée par Cloudflare Access, puis la fiche s'ouvre dans l'application)
function appButtons(c, url) {
  const u = new URL(url);
  if (u.searchParams.get("app") !== "1") return "";
  const open = new URL(`/?concert=${encodeURIComponent(c.id)}`, u.origin).href;
  return `<div class="row app">
        <a class="btn" href="${esc(open)}">Ouvrir dans l'app</a>
        <a class="btn out" href="${esc(open)}&amp;star=interested">★ Ajouter à mes Intéressés</a></div>`;
}

export function page(c, url) {
  const when = `${fmtDate(c.date)}${c.time ? ` à ${c.time.replace(/^(\d+):(\d+)$/, (m, h, mn) => `${Number(h)}h${mn === "00" ? "" : mn}`)}` : ""}`;
  const desc = c.description || [c.style && `Concert ${c.style}`, `${when}, ${c.venue}`].filter(Boolean).join(" · ");
  const tickets = c.tickets.map((t) => `<a class="btn" href="${esc(safeUrl(t.url))}" target="_blank" rel="noopener">Billets sur ${esc(t.source)}</a>`).join("");
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.artist)} · ${esc(when)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(c.artist)} · ${esc(c.venue)}">
<meta property="og:description" content="${esc(when)}${c.genre || c.style ? ` · ${esc(c.genre || c.style)}` : ""}">
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
  .organizer { margin: 0; font-size: .95rem; color: var(--ink); }
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
    <div class="hero" style="${cssUrl(c.picture) ? `background-image:url(&quot;${esc(cssUrl(c.picture))}&quot;)` : ""}"><h1>${esc(c.artist)}</h1></div>
    <div class="body">
      <div class="when">
        <div class="stub"><b>${Number(c.date.slice(8, 10))}</b><span>${esc(new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: "UTC" }).format(new Date(c.date + "T12:00:00Z")))}</span></div>
        <div>
          <p class="date">${esc(when.charAt(0).toUpperCase() + when.slice(1))}</p>
          <p class="venue">${esc(c.venue)}${c.address ? `, ${esc(c.address)}` : ""}</p>
        </div>
      </div>
      ${appButtons(c, url)}
      <div class="tags">
        ${(c.genres?.length ? c.genres : [c.genre || c.style].filter(Boolean)).map((g) => `<span class="tag">${esc(g)}</span>`).join("")}
        ${c.price ? `<span class="tag">${esc(c.price)}</span>` : ""}
        ${c.title && norm(c.title) !== norm(c.artist) ? `<span class="tag">${esc(c.title)}</span>` : ""}
      </div>
      ${c.description ? `<p class="about">${esc(c.description)}</p>
      <p class="source">Sources : Wikidata et Deezer${c.descriptionSource ? ` · <a href="${esc(safeUrl(c.descriptionSource))}" target="_blank" rel="noopener">En savoir plus</a>` : ""}</p>` : ""}
      ${c.organizer ? `<h2>Présentation</h2><p class="organizer">${esc(c.organizer).replace(/\n/g, "<br>")}</p><p class="source">Texte de l'organisateur, publié sur Dice</p>` : ""}
      <h2>Places</h2><div class="row">${tickets}
        <a class="btn out" href="${esc(c.fnac)}" target="_blank" rel="noopener">Chercher sur Fnac Spectacles</a></div>
      <h2>Écouter</h2>
      <div class="row">
        <a class="btn out" href="${esc(safeUrl(c.listen.deezer))}" target="_blank" rel="noopener">Deezer</a>
        <a class="btn out" href="${esc(safeUrl(c.listen.spotify))}" target="_blank" rel="noopener">Spotify</a>
        <a class="btn out" href="${esc(safeUrl(c.listen.youtube))}" target="_blank" rel="noopener">YouTube</a>
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
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// Concert publié, lu directement dans le site (sans passer par la protection d'accès) : petit
// fichier data/share/<2 premiers caractères>.json (src/publish.py, build_share) ; à défaut (avant
// la première publication de ces fichiers), events.json complet
export async function findConcert(env, url, id) {
  // Identifiants publiés : début hexadécimal (empreinte sha1) ; un autre lien est refusé sans
  // relire tout events.json
  if (!/^[0-9a-f]{2}/.test(id)) return null;
  const shard = await env.ASSETS.fetch(new URL(`/data/share/${id.slice(0, 2)}.json`, url));
  // Pages renvoie la page d'accueil pour un fichier absent : seul un JSON est accepté
  if (shard.ok && (shard.headers.get("content-type") || "").includes("json")) {
    return (await shard.json()).find((e) => e.id === id) || null;
  }
  await shard.body?.cancel();
  const all = await env.ASSETS.fetch(new URL("/data/events.json", url));
  if (!all.ok) throw new Error("données indisponibles");
  return (await all.json()).find((e) => e.id === id) || null;
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const waitUntil = (p) => context.waitUntil(p);
  const raw = (params.path || []).join("/");
  const asJson = raw.endsWith(".json");
  const id = raw.replace(/\.json$/, "");
  if (!/^[a-z0-9]{6,40}$/.test(id)) return notFound();

  let found;
  try {
    found = await findConcert(env, request.url, id);
  } catch {
    return new Response("Données indisponibles", { status: 503 });
  }
  if (!found) {
    return asJson ? new Response(JSON.stringify({ error: "concert introuvable" }),
      { status: 404, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) : notFound();
  }
  const ev = withSharedArtist(found, new URL(request.url).searchParams);

  const ctx = { waitUntil, env };
  const info = await concertInfo(ev, ctx);
  if (asJson) {
    return new Response(JSON.stringify(info), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  // Page Dice non lue : page non gardée en cache, nouvel essai (sans texte sur Dice : cache normal)
  const diceMissing = Boolean(ctx.diceFailed);
  return new Response(page(info, request.url), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": diceMissing ? "no-store" : "public, max-age=3600" },
  });
}
