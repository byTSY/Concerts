"use strict";

const state = {
  events: [], artists: [], meta: {}, memberMeta: {}, me: null,
  kinds: new Set(["known", "discovery"]), all: false, favOnly: false, withMembers: false, style: "", venue: null,
  q: "", artistQ: "",  // q : recherche sur tout le catalogue (site/search.js) ; artistQ : filtre de « Mes artistes »
  community: new Map(),  // concert → [{ name, status }] : ★ partagés par les autres membres
  view: "calendar", calendar: null,
  hidden: new Set(), levels: new Map(), starred: new Map(), profile: new Map(), apiError: null, loadFailed: false,
  // Concerts retirés (« Ne plus voir ce concert ») : lignes de l'API et index de recherche
  removed: [], removedIndex: { ids: new Map(), keys: new Map(), links: new Map() }, removedOpen: false,
  byArtistSort: (() => { try { return localStorage.getItem("byArtistSort") || "date"; } catch { return "date"; } })(),
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Lien externe venu des sources (billetteries, pages de salles) : http(s) seulement
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "").trim()) ? String(u).trim() : "#");
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const parseDay = (iso) => new Date(iso + "T12:00:00");
const fmt = (opts) => new Intl.DateTimeFormat("fr-FR", opts);
const fmtShort = fmt({ weekday: "short", day: "numeric", month: "short" });
const fmtMonth = fmt({ month: "long", year: "numeric" });
// Même normalisation que src/util.py (norm) et functions/_lib/http.js
const normName = (s) => String(s ?? "").replace(/['’‘`´]/g, " ").normalize("NFKD").replace(/[^\x00-\x7f]/g, "")
  .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim().replace(/^the /, "");
const isHidden = (name) => state.hidden.has(normName(name));

// Données communes publiées. Une connexion Cloudflare Access expirée renvoie vers la page de
// connexion : la requête échoue ou est redirigée, on le signale au lieu d'afficher une page vide.
async function loadJSON(name, fallback) {
  try {
    const r = await fetch(`data/${name}.json`, { cache: "no-store" });
    if (r.redirected || !r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch {
    state.loadFailed = true;
    return fallback;
  }
}

// Données personnelles : API /api/me/*, le membre étant reconnu par sa connexion Cloudflare Access
class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function api(path, { method = "GET", body, keepalive = false } = {}) {
  let r;
  try {
    r = await fetch(`api/${path}`, {
      method, cache: "no-store", keepalive,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("réseau indisponible ou connexion expirée", 0, "network");
  }
  if (r.redirected) throw new ApiError("connexion expirée", 401, "expired");
  const data = await r.json().catch(() => null);
  if (!r.ok || data === null) throw new ApiError(data?.error || `HTTP ${r.status}`, r.status, data?.code);
  return data;
}

const ACCESS_MESSAGES = {
  not_member: "Votre adresse n'est pas inscrite sur ce site. Demandez une invitation à l'admin.",
  suspended: "Votre accès est suspendu. Contactez l'admin.",
};

// Bandeau d'alerte : connexion expirée (avec bouton de reconnexion) ou accès refusé
function showAccessAlert(e) {
  const text = ACCESS_MESSAGES[e?.code];
  if (text) {
    $("#session-alert-text").textContent = text;
    $("#relogin").style.display = "none";
  }
  $("#session-alert").hidden = false;
}

// Retour sur l'application (raccourci d'écran d'accueil, onglet resté ouvert) : si de nouvelles
// données ont été publiées ou calculées depuis l'ouverture, on recharge la page ; sinon on
// resynchronise les préférences et les concerts mis de côté.
async function checkForUpdate() {
  try {
    const r = await fetch("data/meta.json", { cache: "no-store" });
    if (r.redirected || !r.ok) throw new Error();
    const meta = await r.json();
    if (meta.generated_at && meta.generated_at !== state.meta.generated_at) { location.reload(); return; }
    const me = await api("me");
    if ((me.source?.last_sync_at || null) !== (state.me?.source?.last_sync_at || null)) { location.reload(); return; }
    await Promise.all([loadPrefs(), loadSeen()]);  // fiches Reels vues sur un autre appareil comprises
    applyPrefs();
    renderMasthead();
    render();
  } catch (e) {
    showAccessAlert(e);
  }
}

function headline(ev) {
  if (ev.kind === "known" && ev.matched?.length) return ev.matched.map((m) => m.name).join(", ");
  if (ev.kind === "discovery" && ev.discovery) return ev.discovery.artist;
  return ev.title;
}

function eventClass(ev) {
  if (ev.kind === "other") return "ev-other";
  return ev.kind === "discovery" ? "ev-discovery" : `ev-known-${ev.tier || 3}`;
}

const BADGES = { annonce: "Nouvelle annonce", liste: "Nouveau dans votre liste" };

function badgeTag(ev) {
  return ev.badge ? `<span class="tag tag-new tag-new-${ev.badge}">${BADGES[ev.badge]}</span>` : "";
}

function kindTag(ev, long = false) {
  if (ev.kind === "known") return `<span class="tag tag-known tier-${ev.tier}">${long ? "Vos artistes, niveau" : "Niveau"} ${ev.tier}</span>`;
  if (ev.kind === "discovery") return `<span class="tag tag-discovery">Découverte</span>`;
  return long ? `<span class="tag tag-other">Hors de votre liste</span>` : "";
}

function onSaleInfo(ev) {
  if (!ev.on_sale) return null;
  const d = new Date(ev.on_sale);
  if (isNaN(d) || d < new Date()) return null;
  const day = fmt({ weekday: "long", day: "numeric", month: "long" }).format(d);
  const hour = fmt({ hour: "2-digit", minute: "2-digit" }).format(d);
  return `Mise en vente le ${day} à ${hour}`;
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();
  return { offsale: "Hors vente ou complet", rescheduled: "Date modifiée", postponed: "Reporté", sold_out: "Complet", soldout: "Complet" }[s] || null;
}

/* Préférences : artistes masqués et niveaux imposés --------------------------- */

// Niveau affiché d'un artiste : niveau imposé, sinon niveau calculé au dernier traitement
function tierOf(name, fallback) {
  const key = normName(name);
  return state.levels.get(key) ?? state.profile.get(key)?.tier_auto ?? fallback;
}

// Recalcule l'affichage selon vos préférences : un concert dont tous les artistes rapprochés
// sont masqués passe dans « Tous les concerts » ; les niveaux imposés remplacent les niveaux calculés.
function applyPrefs() {
  for (const a of state.artists) {
    a.tier0 ??= a.tier;
    a.tier = state.levels.get(normName(a.name)) ?? a.tier_auto ?? a.tier0;
  }
  for (const ev of state.events) {
    ev.kind0 ??= ev.kind;
    ev.matched0 ??= ev.matched;
    ev.kind = ev.kind0;
    if (ev.kind0 === "known") {
      ev.matched = (ev.matched0 || []).filter((m) => !isHidden(m.name)).map((m) => ({ ...m, tier: tierOf(m.name, m.tier) }));
      if (!ev.matched.length) ev.kind = "other";
      else ev.tier = Math.min(...ev.matched.map((m) => m.tier));
    } else if (ev.kind0 === "discovery" && isHidden(ev.discovery?.artist)) {
      ev.kind = "other";
    }
  }
  indexRemoved();
}

/* Concerts retirés (« Ne plus voir ce concert ») ------------------------------------- */

const removedKey = (date, venue, title) => `${date}|${normName(venue)}|${normName(title)}`;

// Index des concerts retirés. Un concert se reconnaît à son identifiant ; si cet identifiant n'est
// plus publié (salle ou artiste corrigés par une source, par exemple), à la même date et, soit à sa
// salle et son titre, soit à un lien qu'aucun autre concert du même jour ne porte (page programme
// d'une salle ou d'un festival écartée). Une date modifiée fait revenir le concert.
// Même règle que la newsletter (src/newsletter.py, removed_rule).
function indexRemoved() {
  const ids = new Map(), keys = new Map(), links = new Map();
  const published = new Set(state.events.map((e) => e.id));
  const linkUse = new Map();  // « date|lien » → nombre de concerts publiés qui le portent
  for (const e of state.events) {
    for (const l of e.links || []) linkUse.set(`${e.date}|${l.url}`, (linkUse.get(`${e.date}|${l.url}`) || 0) + 1);
  }
  for (const r of state.removed) {
    ids.set(r.concert_id, r);
    if (published.has(r.concert_id)) continue;
    if (r.venue && r.title) keys.set(removedKey(r.concert_date, r.venue, r.title), r);
    for (const u of r.urls || []) {
      if ((linkUse.get(`${r.concert_date}|${u}`) || 0) <= 1) links.set(`${r.concert_date}|${u}`, r);
    }
  }
  state.removedIndex = { ids, keys, links };
}

function setRemoved(list) {
  state.removed = Array.isArray(list) ? list : [];
  indexRemoved();
}

// Ligne de retrait d'un concert, ou null
function removalOf(ev) {
  if (!ev) return null;
  const { ids, keys, links } = state.removedIndex;
  if (ids.has(ev.id)) return ids.get(ev.id);
  if (!keys.size && !links.size) return null;
  ev.removedKey ??= removedKey(ev.date, ev.venue, ev.title);
  return keys.get(ev.removedKey) || (ev.links || []).map((l) => links.get(`${ev.date}|${l.url}`)).find(Boolean) || null;
}
const isRemoved = (ev) => Boolean(removalOf(ev));

// « Ne plus voir ce concert » : il sort du calendrier, des listes et des Reels, sans toucher à
// l'artiste ; sa ★ est effacée (confirmation pour « Places prises »). Renvoie la fonction
// d'annulation, null si le membre renonce ; une erreur d'enregistrement est levée.
async function removeConcert(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev || isRemoved(ev)) return null;
  const star = state.starred.get(id);
  if (star?.status === "going" && !confirm("Vous avez noté des places prises pour ce concert.\n\nLe retirer quand même ? Le statut « Places prises » sera effacé.")) return null;
  const body = { label: starLabel(ev), date: ev.date, venue: ev.venue, title: ev.title,
    urls: (ev.links || []).map((l) => l.url).filter((u) => /^https?:\/\//i.test(u || "")).slice(0, 5) };
  // ★ envoyée juste avant (clic sur « Intéressé » puis retrait) : attendue, sinon elle arriverait
  // au serveur après le retrait et reviendrait sur un concert retiré
  await starQueue.get(id)?.tail;
  const r = await api(`me/removed/${encodeURIComponent(id)}`, { method: "PUT", body });
  setRemoved(r.removed);
  setStars(r.stars);
  afterRemovedChange();
  return () => restoreConcert(id, star);
}

// « Remettre » : le concert revient ; star : ★ effacée au retrait, rétablie par « Annuler »
async function restoreConcert(id, star = null) {
  setRemoved(await api(`me/removed/${encodeURIComponent(id)}`, { method: "DELETE" }));
  if (star) {
    setStars(await api(`me/stars/${encodeURIComponent(id)}`, { method: "PUT",
      body: { label: star.label, status: star.status, visibility: star.visibility } }));
  }
  afterRemovedChange();
  toast("Concert remis dans votre calendrier");
}

function afterRemovedChange() {
  state.apiError = null;
  updateStarCount();
  renderMasthead();
  render();
}

function setPrefs(data) {
  state.hidden = new Set((data.hidden || []).map(normName));
  state.levels = new Map(Object.entries(data.levels || {}).map(([n, t]) => [normName(n), Number(t)]));
}

// ★ du membre : concert → { label, status (interested, going), visibility (private, members) }
function setStars(list) {
  state.starred = new Map((list || []).map((s) => [s.concert_id,
    // Valeur absente (jamais renvoyée par l'API) : masqué, par prudence
    { label: s.label, status: s.status || "interested", visibility: s.visibility || "private" }]));
}

// ★ partagés par les autres membres (section 12 de la spécification)
function setCommunity(list) {
  state.community = new Map();
  for (const s of list || []) {
    if (!state.community.has(s.concert_id)) state.community.set(s.concert_id, []);
    state.community.get(s.concert_id).push({ name: s.name, status: s.status });
  }
}

const membersOf = (ev) => state.community.get(ev.id) || [];
const membersTag = (ev) => {
  const n = membersOf(ev).length;
  return n ? `<span class="tag tag-members" title="Membres qui ont mis ce concert de côté">${n} membre${n > 1 ? "s" : ""}</span>` : "";
};

// Concerts communs + ce qu'ils sont pour le membre (overlay calculé par le traitement) :
// genre de rapprochement, niveau, artistes, découverte, badge « liste », salle favorite.
// Le fichier commun ne porte que le badge « annonce ».
function mergeOverlay(events, overlay) {
  for (const ev of events) {
    const o = overlay[ev.id] || {};
    ev.kind = o.kind || "other";
    ev.tier = o.tier;
    ev.matched = o.matched || [];
    ev.discovery = o.discovery || null;
    ev.venue_favorite = Boolean(o.venue_favorite);
    ev.badge = ev.badge === "annonce" ? "annonce" : o.badge || null;
  }
  return events;
}

/* Concerts mis de côté (« Intéressés ») ------------------------------------------ */

const isStarred = (id) => state.starred.has(id);
const starLabel = (ev) => `${ev.date}${ev.time ? " " + ev.time : ""} · ${headline(ev)} · ${ev.venue}`;

function starButton(ev, long = false) {
  const on = isStarred(ev.id);
  const text = long ? (on ? "★ Dans mes concerts intéressés" : "☆ Mettre de côté") : (on ? "★" : "☆");
  const title = on ? "Retirer de mes concerts intéressés" : "Mettre de côté dans mes concerts intéressés";
  return `<button type="button" class="${long ? "btn btn-star" : "star-toggle"}${on ? " on" : ""}" data-star="${esc(ev.id)}" aria-pressed="${on}" title="${title}" aria-label="${title}">${text}</button>`;
}

// Enregistrements d'un même concert envoyés l'un après l'autre (clics rapprochés) ; la réponse
// d'un envoi n'est appliquée que s'il est le dernier en attente, pour ne pas effacer un clic suivant
const starQueue = new Map();  // concert → { tail: promesse, pending: nombre d'envois en attente }
function queueStar(id, task) {
  const q = starQueue.get(id) || { tail: Promise.resolve(), pending: 0 };
  q.pending += 1;
  starQueue.set(id, q);
  const last = () => q.pending === 1;
  q.tail = q.tail.then(() => task(last)).finally(() => {
    q.pending -= 1;
    if (!q.pending) starQueue.delete(id);
  });
  return q.tail;
}

// Mise à jour immédiate de l'affichage, puis enregistrement ; retour en arrière si l'enregistrement échoue
function toggleStar(id) {
  const ev = state.events.find((e) => e.id === id);
  const previous = state.starred.get(id);
  const label = ev ? starLabel(ev) : previous?.label || id;
  const star = !isStarred(id);
  star ? state.starred.set(id, { label, status: "interested", visibility: state.me?.default_visibility || "members" }) : state.starred.delete(id);
  refreshStars(id);
  return queueStar(id, async (last) => {
    try {
      const path = `me/stars/${encodeURIComponent(id)}`;
      const list = await (star ? api(path, { method: "PUT", body: { label } }) : api(path, { method: "DELETE" }));
      if (last()) setStars(list);
      state.apiError = null;
      toast(star ? "Ajouté à vos concerts intéressés"
        : previous?.status === "going" ? "Places prises retirées de vos concerts" : "Retiré de vos concerts intéressés");
    } catch (e) {
      if (last()) star ? state.starred.delete(id) : state.starred.set(id, previous);
      alert(`L'enregistrement a échoué : ${e.message}.\n\nRéessayez dans un instant ; si le problème persiste, rechargez la page.`);
    }
    refreshStars(id);
  });
}

// Statut (« places prises ») ou visibilité d'un concert ; un concert pas encore mis de côté l'est.
// Affichage mis à jour tout de suite, retour en arrière si l'enregistrement échoue.
function setStarOption(id, field, value, onCreate = {}) {
  const ev = state.events.find((e) => e.id === id);
  const previous = state.starred.get(id);
  const created = !previous;
  const label = previous?.label || (ev ? starLabel(ev) : id);
  state.starred.set(id, { label, status: "interested", visibility: state.me?.default_visibility || "members",
    ...(created ? onCreate : {}), ...previous, [field]: value });
  refreshStars(id);
  const body = { [field]: value, ...(created ? { label, ...onCreate } : {}) };
  return queueStar(id, async (last) => {
    try {
      const list = await api(`me/stars/${encodeURIComponent(id)}`, { method: "PUT", body });
      if (last()) setStars(list);
      toast(field === "status"
        ? (value === "going" ? "Noté : places prises" : created ? "Ajouté à vos concerts intéressés" : "Noté : intéressé")
        : (value === "members" ? "Visible par les membres" : "Masqué : visible par vous seul"));
    } catch (e) {
      if (last()) previous ? state.starred.set(id, previous) : state.starred.delete(id);
      toast(`Enregistrement impossible : ${e.message}`);
    }
    refreshStars(id);
  });
}

// Fiche d'un concert : « Intéressé » ou « Places prises », partage avec les membres, retrait
function starBlock(ev) {
  const removal = removalOf(ev);
  if (removal) {
    return `<p class="cell-sub">Vous avez retiré ce concert de votre calendrier.</p>
      <button type="button" class="btn" data-restore="${esc(removal.concert_id)}">Remettre dans le calendrier</button>`;
  }
  const s = state.starred.get(ev.id);
  const choice = (status, off, on) => `<button type="button" class="btn btn-star${s?.status === status ? " on" : ""}"
    data-star-set="${status}" data-star-id="${esc(ev.id)}" aria-pressed="${s?.status === status}">${s?.status === status ? on : off}</button>`;
  return `${choice("interested", "☆ Intéressé", "★ Intéressé")}${choice("going", "🎟 Places prises", "✓ Places prises")}
    ${s ? `<label class="chip star-share"><input type="checkbox" data-star-share data-star-id="${esc(ev.id)}"${s.visibility === "members" ? " checked" : ""}> Visible par les membres</label>
      <button type="button" class="link-btn" data-star="${esc(ev.id)}">Retirer de mes concerts</button>` : ""}`;
}

// Fiche d'un concert : membres qui l'ont mis de côté et le partagent
function membersBlock(ev) {
  const list = membersOf(ev);
  if (!list.length) return "";
  const names = (status) => list.filter((m) => m.status === status).map((m) => esc(m.name)).join(", ");
  const going = names("going");
  const interested = names("interested");
  return `<div class="ticket-section"><h3>Membres</h3><p>${[interested ? `Intéressés : ${interested}` : "", going ? `Ont leurs places : ${going}` : ""].filter(Boolean).join("<br>")}</p></div>`;
}

function refreshStars(id) {
  const ev = state.events.find((e) => e.id === id);
  if (ev && $("#ticket").open) {
    const box = $("#ticket-star");
    if (box) box.innerHTML = starBlock(ev);
  }
  updateStarCount();
  renderUpcoming();
  renderRemoved();
  renderSearch();
  if (state.view !== "calendar") render();
  else if (state.calendar) renderCalendar();
}

function updateStarCount() {
  const n = state.starred.size;
  $("#star-count").textContent = n ? ` (${n})` : "";
}

async function loadPrefs() {
  try {
    const [prefs, stars, community, removed] = await Promise.all([api("me/prefs"), api("me/stars"),
      api("community/stars").catch(() => []), api("me/removed").catch(() => state.removed)]);
    setPrefs(prefs);
    setStars(stars);
    setRemoved(removed);
    setCommunity(community);
    state.apiError = null;
  } catch (e) {
    // Site ouvert en local, fonction Cloudflare non configurée ou connexion expirée
    state.apiError = e.message;
  }
}

// name : nom de l'artiste ; change : { hidden } ou { level } (null : niveau calculé)
async function savePref(name, change, done) {
  try {
    setPrefs(await api(`me/artists/${encodeURIComponent(normName(name))}`, { method: "PUT", body: { name, ...change } }));
    state.apiError = null;
  } catch (e) {
    alert(`L'enregistrement a échoué : ${e.message}.\n\nRéessayez dans un instant ; si le problème persiste, rechargez la page.`);
    render();  // remet les menus dans leur état réel
    return;
  }
  applyPrefs();
  if ($("#ticket").open) $("#ticket").close();
  renderMasthead();
  render();
  toast(done);
}

function setHidden(name, hide) {
  const question = hide
    ? `Ne plus recommander ${name} ?\n\nSes concerts sortiront de « Vos artistes » et des découvertes (ils resteront dans « Tous les concerts »). Vous pourrez annuler depuis l'onglet Mes artistes.`
    : `Recommander à nouveau ${name} ?`;
  if (!confirm(question)) return;
  savePref(name, { hidden: hide },
    hide ? `${name} ne sera plus recommandé` : `${name} est de nouveau recommandé`);
}

function setLevel(name, level) {
  const key = normName(name);
  const upcoming = state.events.filter((ev) => (ev.matched0 || []).some((m) => normName(m.name) === key)).length;
  const effect = upcoming
    ? `${upcoming} concert${upcoming > 1 ? "s" : ""} à venir mis à jour`
    : "aucun concert à venir pour l'instant, le niveau s'appliquera aux prochains";
  savePref(name, { level },
    `${name} : ${level ? `niveau ${level} imposé` : "niveau calculé à partir de vos likes"} (${effect})`);
}

/* Partage d'un concert ------------------------------------------------------------ */

// « ANGINE DE POITRINE » -> « Angine De Poitrine » ; les noms en casse mixte sont gardés
const tidy = (s) => {
  s = String(s ?? "").trim();
  return s !== s.toUpperCase() || !/[A-Z]/.test(s) ? s : s.toLowerCase().replace(/(^|[\s\-'’(/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
};
const startsWithVowel = (s) => /^[aeiouyhàâäéèêëîïôöùûü]/i.test(s);
const FEMININE = /^(salle|cite|maison|philharmonie|eglise|chapelle|cathedrale|basilique|seine|gaite|boule|scene|grande|petite|bellevilloise|cigale|fondation|machine|maroquinerie|fleche|bourse|halle|station)\b/;

// « au New Morning », « à l'Olympia », « à la Cigale », « aux Étoiles »
function atVenue(venue) {
  // « La Seine Musicale - Grande Seine » -> « La Seine Musicale » ; mais « Salle des concerts - Cité de
  // la Musique » -> « Cité de la Musique », la première partie n'étant qu'un nom de salle générique
  const parts = tidy(venue).split(/\s+-\s+/);
  const v = parts.length > 1 && /^(grande |petite )?(salle|auditorium|studio|amphi)/i.test(parts[0]) ? parts[1] : parts[0];
  const m = v.match(/^(le|la|les|l['’])\s*(.*)$/i);
  if (m) {
    const art = m[1].toLowerCase();
    return art === "le" ? `au ${m[2]}` : art === "les" ? `aux ${m[2]}` : art === "la" ? `à la ${m[2]}` : `à l'${m[2]}`;
  }
  if (startsWithVowel(v)) return `à l'${v}`;
  return FEMININE.test(normName(v)) ? `à la ${v}` : `au ${v}`;
}

// « C'est du rock », « C'est de la soul » : genre précis d'abord, famille de styles à défaut
const GENRE_PHRASES = [
  [/pop rock|pop \/ rock/, "de la pop-rock"], [/metal/, "du metal"], [/punk/, "du punk"], [/hip hop|\brap\b/, "du rap"],
  [/\br b\b|\brnb\b/, "du R&B"], [/soul/, "de la soul"], [/funk/, "du funk"], [/blues/, "du blues"], [/jazz/, "du jazz"],
  [/reggae|dub/, "du reggae"], [/techno/, "de la techno"], [/house/, "de la house"], [/electro|dance/, "de l'électro"],
  [/folk/, "du folk"], [/rock/, "du rock"], [/\bpop\b/, "de la pop"], [/chanson|variete francaise/, "de la chanson française"],
  [/opera|lyrique/, "de l'opéra"], [/classi|symphoni|baroque|chambre/, "du classique"],
  [/monde|world|latin|afri|bresil|salsa|samba/, "de la musique du monde"],
];
// Premier terme pertinent du genre : « Jazz caribéen, Jazz / Blues » -> « jazz caribeen » (et non « blues »)
const NOT_GENRE = /^(eglise|piano|violon|orgue|guitare|concert a la bougie|concert de noel|choix de la redaction|music|other|undefined)$/;
const mainGenre = (ev) => String(ev.genre || "").split(",").map(normName).find((g) => g && !NOT_GENRE.test(g)) || "";
const genrePhrase = (ev) => GENRE_PHRASES.find(([re]) => re.test(mainGenre(ev)))?.[1] || null;
const hourText = (t) => t.replace(/^(\d+):(\d+)$/, (m, h, mn) => `${Number(h)}h${mn === "00" ? "" : mn}`);

function shareArtist(ev) {
  if (ev.kind === "known" && ev.matched?.length) return { name: ev.matched[0].name, link: ev.matched[0].link };
  if (ev.kind === "discovery" && ev.discovery) return { name: ev.discovery.artist, link: ev.discovery.link };
  return { name: tidy((ev.artists || [])[0] || ev.title), link: null };
}

// Fiche publique d'un concert : l'artiste qui vous intéresse est précisé dans le lien, les
// données publiées ne disant pas quel artiste de la programmation compte pour chaque membre
function shareQuery(ev) {
  if (ev.kind === "other") return "";
  const { name, link } = shareArtist(ev);
  const dz = String(link || "").match(/deezer\.com\/(?:\w+\/)?artist\/(\d+)/)?.[1];
  return `?a=${encodeURIComponent(name)}${dz ? `&dz=${dz}` : ""}`;
}

function messageText(ev, info) {
  const artist = shareArtist(ev);
  const name = info?.artist || artist.name;
  const day = fmt({ weekday: "long", day: "numeric", month: "long" }).format(parseDay(ev.date));
  const when = `le ${day}${ev.time ? ` à ${hourText(ev.time)}` : ""}`;
  // Genre précis de Wikidata (« du rock psychédélique ») ; à défaut, celui de la billetterie
  const style = info?.styleText || genrePhrase(ev);
  // « Groupe de rock anglais, dans la veine de Tame Impala, Pond et Jacco Gardner. »
  const desc = (info?.description || "").trim();
  const lines = [
    `Hey, il y a le concert ${startsWithVowel(name) ? "d'" : "de "}${name} ${when}, ${atVenue(ev.venue)}.`,
    [style ? `C'est ${style}.` : "", desc].filter(Boolean).join(" "),
    "On prend des places ?",
    "",
    // Lien vers la fiche web du concert (photo, infos, billets, écoute)
    new URL(`partage/${ev.id}${shareQuery(ev)}`, location.href).href,
  ];
  return lines.filter((l, i) => l || i === 3).join("\n");
}

// Menu de partage du téléphone (WhatsApp, Messages…) ; sinon copie dans le presse-papiers
async function shareOrCopy(data, copied) {
  if (navigator.share) {
    try { await navigator.share(data); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(data.url ? `${data.text ? data.text + "\n" : ""}${data.url}` : data.text);
    toast(copied);
  } catch {
    prompt("Copiez ce texte :", data.url || data.text);
  }
}

// Description, genres et liens d'écoute de l'artiste, préparés par la fonction de partage
// (Wikidata et Deezer) ; gardés en mémoire pour la fiche du concert et le message.
const artistInfoCache = new Map();
function artistInfo(id, timeout = 8000) {
  if (!artistInfoCache.has(id)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const ev = state.events.find((e) => e.id === id);
    artistInfoCache.set(id, fetch(`partage/${id}.json${ev ? shareQuery(ev) : ""}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer))
      // Nouvel essai plus tard : réponse absente, ou présentation Dice manquante (page Dice non lue)
      .then((info) => {
        if (!info || (!info.organizer && (ev?.links || []).some((l) => l.source === "Dice"))) artistInfoCache.delete(id);
        return info;
      }));
  }
  return artistInfoCache.get(id);
}

// Section « L'artiste » de la fiche d'un concert, remplie dès que les informations arrivent
async function fillArtistSection(ev) {
  const info = await artistInfo(ev.id);
  const box = $("#ticket-artist");
  if (!box || box.dataset.id !== ev.id || !$("#ticket").open) return;  // fiche fermée ou changée entre-temps
  if (!info || (!info.description && !info.genres?.length && !info.organizer)) { box.remove(); return; }
  const tags = (info.genres || []).map((g) => `<span class="tag tag-genre">${esc(g)}</span>`).join(" ");
  // Membre Spotify : lien Spotify en premier
  const order = state.me?.source?.provider === "spotify" ? ["spotify", "deezer", "youtube"] : ["deezer", "spotify", "youtube"];
  const listen = info.listen ? order.map((k) =>
    `<a class="buy-link" href="${esc(safeUrl(info.listen[k]))}" target="_blank" rel="noopener">${{ deezer: "Deezer", spotify: "Spotify", youtube: "YouTube" }[k]}</a>`).join(" ") : "";
  box.innerHTML = `<h3>L'artiste</h3>
    ${tags ? `<p class="artist-genres">${tags}</p>` : ""}
    ${info.description ? `<p>${esc(info.description)}</p>` : ""}
    ${info.organizer ? `<details class="organizer"><summary>Présentation de l'organisateur (Dice)</summary><p>${esc(info.organizer).replace(/\n/g, "<br>")}</p></details>` : ""}
    ${listen ? `<p class="buy-links">${listen}</p>` : ""}
    ${info.descriptionSource ? `<p class="cell-sub">Sources : Wikidata et Deezer · <a href="${esc(safeUrl(info.descriptionSource))}" target="_blank" rel="noopener">En savoir plus</a></p>` : ""}`;
  box.classList.remove("loading");
}

async function shareMessage(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  const info = await artistInfo(id, 2500);  // message sans description si l'information tarde
  // Le lien de la fiche est dans le texte : certaines applications ignorent un lien passé à part
  await shareOrCopy({ text: messageText(ev, info) }, "Message copié : collez-le dans WhatsApp ou Messages");
}

// action : { label, run } facultatif, bouton dans le message (ex. Annuler)
function toast(text, action) {
  const el = $("#toast");
  el.textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link-btn toast-action";
    b.textContent = action.label;
    b.addEventListener("click", () => { el.hidden = true; action.run(); }, { once: true });
    el.append(" ", b);
  }
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 6000);
}

/* Styles ------------------------------------------------------------------------ */

// Familles de styles, à partir des genres hétérogènes des sources (normalisés sans accents)
const STYLES = [
  ["jazz", "Jazz, blues, soul", /jazz|blues|soul|funk|gospel|swing|manouche/],
  ["rap", "Rap, R&B", /\brap\b|hip hop|urbain|\br b\b|\brnb\b/],
  ["pop", "Pop, rock, folk", /\bpop\b|rock|punk|folk|alternative|indie|country|variete internationale/],
  ["electro", "Électro", /electro|\bdance\b|techno|house/],
  ["metal", "Metal", /metal|hardcore/],
  ["chanson", "Chanson française", /chanson|variete francaise|french/],
  ["monde", "Musiques du monde", /monde|world|oriental|reggae|bresil|latin|salsa|samba|afri|flamenco|klezmer|indienne|andalouse|caribeen|traditionnel/],
  ["classique", "Classique, opéra", /classi|symphoni|chambre|baroque|lyrique|opera|sacree|religious|orgue|romantique|piano|violon|eglise|contemporain|medieval|noel|bougie/],
  ["autre", "Ciné-concerts, humour, jeune public", /cine|film|jeux video|comedy|theatre|children/],
];

function stylesOf(ev) {
  if (!ev.styles) {
    const g = normName(ev.genre || "");
    ev.styles = STYLES.filter(([, , re]) => re.test(g)).map(([key]) => key);
    if (!ev.styles.length) ev.styles = ["none"];
  }
  return ev.styles;
}

const styleOk = (ev) => !state.style || stylesOf(ev).includes(state.style);

function fillStyles() {
  const count = (key) => state.events.filter((ev) => stylesOf(ev).includes(key)).length;
  $("#style-filter").innerHTML = `<option value="">Tous les styles</option>` +
    [...STYLES, ["none", "Style non renseigné"]].map(([key, label]) => `<option value="${key}">${esc(label)} (${count(key)})</option>`).join("");
}

/* Filtres ------------------------------------------------------------------ */

function filtered() {
  return state.events.filter((ev) => {
    if (isRemoved(ev)) return false;
    if (state.withMembers) {
      if (!membersOf(ev).length) return false;
    } else if (!state.all && !state.kinds.has(ev.kind)) return false;
    if (!styleOk(ev)) return false;
    if (state.favOnly && !ev.venue_favorite) return false;
    if (state.venue && ev.venue !== state.venue) return false;
    return true;
  });
}

function setVenueFilter(name) {
  state.venue = name;
  const box = $("#venue-filter");
  if (name) {
    box.hidden = false;
    box.innerHTML = `${esc(name)} <button type="button" aria-label="Retirer le filtre de salle">×</button>`;
    box.querySelector("button").onclick = () => setVenueFilter(null);
  } else {
    box.hidden = true;
    box.innerHTML = "";
  }
  render();
}

/* En-tête et nouveautés ------------------------------------------------------ */

function renderMasthead() {
  const m = state.meta;
  if (m.generated_at) {
    const d = new Date(m.generated_at);
    $("#updated").textContent = `Mis à jour le ${fmt({ weekday: "long", day: "numeric", month: "long" }).format(d)} à ${fmt({ hour: "2-digit", minute: "2-digit" }).format(d)}, ${state.memberMeta.counts?.artists ?? state.artists.length} artistes suivis`;
  }
  // Nouveautés de votre liste (vos artistes et découvertes) uniquement
  const fresh = state.events.filter((e) => e.badge && e.kind !== "other" && !isRemoved(e));
  const na = fresh.filter((e) => e.badge === "annonce").length;
  const nl = fresh.length - na;
  const parts = [];
  if (na) parts.push(`${na} nouvelle${na > 1 ? "s" : ""} annonce${na > 1 ? "s" : ""}`);
  if (nl) parts.push(`${nl} concert${nl > 1 ? "s" : ""} nouveau${nl > 1 ? "x" : ""} dans votre liste`);
  $("#fresh-title").textContent = !m.generated_at ? ""
    : m.initial ? `Base initiale : ${m.counts?.concerts ?? state.events.length} concerts enregistrés. Les nouveautés seront signalées à partir de la prochaine mise à jour.`
    : parts.length ? `${parts.join(" et ")} cette semaine`
    : "Aucune nouveauté cette semaine";
  renderReelsRing();  // cercle « Reels » : fiches plein écran des nouveautés (site/reels.js)
  renderUpcoming();   // Mes prochains concerts, concerts retirés et recherche (site/search.js)
  renderRemoved();
  renderSearch();
}

/* Calendrier ----------------------------------------------------------------- */

function renderCalendar() {
  const events = filtered().map((ev) => ({
    id: ev.id,
    title: `${isStarred(ev.id) ? "★ " : ""}${headline(ev)} (${ev.venue})`,
    start: ev.time ? `${ev.date}T${ev.time}` : ev.date,
    allDay: !ev.time,
    classNames: [eventClass(ev)],
  }));
  if (!state.calendar) {
    state.calendar = new FullCalendar.Calendar($("#calendar"), {
      locale: "fr",
      initialView: window.innerWidth < 640 ? "listMonth" : "dayGridMonth",
      headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,listMonth" },
      buttonText: { today: "Aujourd'hui", month: "Mois", list: "Liste" },
      height: "auto",
      eventDisplay: "block",
      dayMaxEventRows: 4,
      eventTimeFormat: { hour: "2-digit", minute: "2-digit", meridiem: false },
      noEventsContent: "Aucun concert sur cette période avec les filtres actuels",
      eventClick: (info) => openTicket(info.event.id),
      datesSet: (info) => { $("#cal-bottom-title").textContent = info.view.title; },
      events: [],
    });
    state.calendar.render();
  }
  state.calendar.removeAllEvents();
  state.calendar.addEventSource(events);
}

// Changement de mois depuis le bas de page ou par balayage : on revient en haut du calendrier
function moveMonth(step) {
  if (!state.calendar) return;
  step > 0 ? state.calendar.next() : state.calendar.prev();
  const cal = $("#calendar");
  cal.classList.remove("cal-slide-next", "cal-slide-prev");
  void cal.offsetWidth;  // relance l'animation
  cal.classList.add(step > 0 ? "cal-slide-next" : "cal-slide-prev");
  // Après le rendu du nouveau mois (sinon le changement de hauteur interrompt le défilement)
  setTimeout(() => {
    if (cal.getBoundingClientRect().top < 0) {
      const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
      cal.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    }
  }, 50);
}

function bindSwipe(el) {
  let start = null;
  el.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { start = null; return; }
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    // Geste horizontal net et rapide ; un défilement vertical ne change pas de mois
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && Date.now() - start.t < 800) moveMonth(dx < 0 ? 1 : -1);
    start = null;
  }, { passive: true });
}

/* Liste ---------------------------------------------------------------------- */

function renderList() {
  const items = filtered();
  if (!items.length) { $("#list").innerHTML = emptyMessage(); return; }
  const byMonth = new Map();
  for (const ev of items) {
    const key = ev.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(ev);
  }
  let html = "";
  for (const [key, evs] of byMonth) {
    html += `<div class="month-block"><h2 class="month-title">${esc(fmtMonth.format(parseDay(key + "-01")))}</h2>
      <div class="table-wrap"><table class="events"><colgroup><col class="c-date"><col class="c-name"><col class="c-venue"><col class="c-price hide-mobile"><col class="c-tags"></colgroup><thead><tr><th>Date</th><th>Concert</th><th>Salle</th><th class="hide-mobile">Prix</th><th></th></tr></thead><tbody>`;
    for (const ev of evs) {
      const sub = ev.kind === "discovery" && ev.discovery?.close_to?.length
        ? `Proche de ${ev.discovery.close_to.slice(0, 2).join(" et ")}` : (headline(ev) !== ev.title ? ev.title : "");
      html += `<tr class="clickable" data-id="${ev.id}" tabindex="0">
        <td class="cell-date">${esc(fmtShort.format(parseDay(ev.date)))}${ev.time ? `<span class="cell-sub">${esc(ev.time)}</span>` : ""}</td>
        <td><span class="cell-name">${esc(headline(ev))}</span>${sub ? `<span class="cell-sub">${esc(sub)}</span>` : ""}</td>
        <td>${esc(ev.venue)}${ev.venue_favorite ? ` <span class="tag tag-fav">Favorite</span>` : ""}</td>
        <td class="hide-mobile">${esc(ev.price || "")}</td>
        <td>${starButton(ev)} ${[kindTag(ev), badgeTag(ev), membersTag(ev)].filter(Boolean).join(" ")}</td>
      </tr>`;
    }
    html += `</tbody></table></div></div>`;
  }
  $("#list").innerHTML = html;
}

/* Par artiste ------------------------------------------------------------------ */

const SORTS = {
  date: (a, b) => a.next.date.localeCompare(b.next.date) || (a.next.time || "").localeCompare(b.next.time || "") || a.name.localeCompare(b.name, "fr"),
  name: (a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
  added: (a, b) => (b.added || "").localeCompare(a.added || "") || SORTS.date(a, b),
};

// Vos artistes (hors masqués) qui ont au moins un concert à venir, avec leur prochaine date
function artistRows() {
  const profile = new Map(state.artists.map((a) => [normName(a.name), a]));
  const rows = new Map();
  for (const ev of state.events) {
    if (ev.kind !== "known" || !styleOk(ev) || isRemoved(ev)) continue;
    for (const m of ev.matched) {
      const key = normName(m.name);
      if (!rows.has(key)) {
        const p = profile.get(key) || {};
        rows.set(key, { name: m.name, tier: m.tier, link: m.link || p.link, picture: p.picture, added: p.added, events: [] });
      }
      rows.get(key).events.push(ev);
    }
  }
  return [...rows.values()]
    .map((r) => {
      r.events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
      r.next = r.events[0];
      return r;
    })
    .sort(SORTS[state.byArtistSort] || SORTS.date);
}

function renderByArtist() {
  $("#byartist-sort").value = state.byArtistSort;
  const rows = artistRows();
  if (!state.events.length) { $("#byartist").innerHTML = emptyMessage(); return; }
  if (!rows.length) { $("#byartist").innerHTML = `<div class="empty">Aucun de vos artistes n'a de concert à venir avec ce style.</div>`; return; }
  const fmtAdded = fmt({ day: "numeric", month: "short", year: "numeric" });
  let html = `<p class="count-line">${rows.length} de vos artistes ont au moins un concert à venir.</p>
    <div class="table-wrap"><table class="events"><thead><tr><th>Artiste</th><th>Prochain concert</th><th>Salle</th><th class="hide-mobile">Autres dates</th><th class="hide-mobile">Ajouté sur Deezer</th></tr></thead><tbody>`;
  for (const r of rows) {
    const ev = r.next;
    const later = r.events.slice(1);
    const laterText = later.length
      ? later.slice(0, 3).map((e) => fmtShort.format(parseDay(e.date))).join(", ") + (later.length > 3 ? ` et ${later.length - 3} de plus` : "")
      : "";
    const badge = r.events.find((e) => e.badge);
    html += `<tr class="clickable" data-id="${ev.id}" tabindex="0">
      <td>${r.picture ? `<img class="artist-thumb" src="${esc(r.picture)}" alt="" loading="lazy">` : ""}<span class="cell-name">${esc(r.name)}</span>
        <span class="cell-sub"><span class="tag tag-known tier-${r.tier}">Niveau ${r.tier}</span>${badge ? ` ${badgeTag(badge)}` : ""}</span></td>
      <td class="cell-date">${esc(fmtShort.format(parseDay(ev.date)))}${ev.time ? `<span class="cell-sub">${esc(ev.time)}</span>` : ""}</td>
      <td>${esc(ev.venue)}${ev.venue_favorite ? ` <span class="tag tag-fav">Favorite</span>` : ""}</td>
      <td class="hide-mobile">${later.length ? `<span class="cell-name">${later.length}</span><span class="cell-sub">${esc(laterText)}</span>` : ""}</td>
      <td class="hide-mobile cell-date">${r.added ? esc(fmtAdded.format(parseDay(r.added))) : ""}</td>
    </tr>`;
  }
  $("#byartist").innerHTML = html + `</tbody></table></div>`;
}

/* Intéressés ------------------------------------------------------------------- */

function renderStarred() {
  const items = [...state.starred].map(([id, s]) => ({ id, label: s.label, star: s, ev: state.events.find((e) => e.id === id) }));
  const upcoming = items.filter((i) => i.ev)
    .sort((a, b) => a.ev.date.localeCompare(b.ev.date) || (a.ev.time || "").localeCompare(b.ev.time || ""));
  const gone = items.filter((i) => !i.ev);
  if (!items.length) {
    $("#starred").innerHTML = `<div class="empty"><strong>Aucun concert mis de côté.</strong><br>
      Ouvrez un concert et cliquez sur « ☆ Mettre de côté », ou sur l'étoile dans la liste : vous le retrouverez ici pour acheter vos places.</div>`;
    return;
  }
  let html = `<p class="count-line">${upcoming.length} concert${upcoming.length > 1 ? "s" : ""} mis de côté, du plus proche au plus lointain.</p>`;
  if (upcoming.length) {
    html += `<div class="table-wrap"><table class="events"><thead><tr><th>Date</th><th>Concert</th><th>Salle</th><th class="hide-mobile">Prix</th><th>Billets</th><th></th></tr></thead><tbody>`;
    for (const { ev, star } of upcoming) {
      const sale = onSaleInfo(ev);
      const status = statusLabel(ev.status);
      const links = (ev.links || []).map((l) => `<a class="buy-link" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.source)}</a>`).join(" ");
      html += `<tr class="clickable" data-id="${ev.id}" tabindex="0">
        <td class="cell-date">${esc(fmtShort.format(parseDay(ev.date)))}${ev.time ? `<span class="cell-sub">${esc(ev.time)}</span>` : ""}</td>
        <td><span class="cell-name">${esc(headline(ev))}</span>${headline(ev) !== ev.title ? `<span class="cell-sub">${esc(ev.title)}</span>` : ""}
          <span class="cell-sub">${star.status === "going" ? `<span class="tag tag-going">Places prises</span> ` : ""}${star.visibility === "members" ? "visible par les membres" : "masqué"} ${membersTag(ev)}</span></td>
        <td>${esc(ev.venue)}</td>
        <td class="hide-mobile">${esc(ev.price || "")}</td>
        <td>${status ? `<span class="cell-sub"><strong>${esc(status)}</strong></span>` : ""}${sale ? `<span class="stub-sale">${esc(sale.replace("Mise en vente le ", "En vente le "))}</span>` : ""}<span class="buy-links">${links}</span></td>
        <td>${starButton(ev)}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
  }
  if (gone.length) {
    html += `<h2 class="month-title">Passés ou retirés des billetteries</h2><ul class="gone-list">` +
      gone.map((i) => `<li>${esc(i.label)} <button type="button" class="link-btn" data-star="${esc(i.id)}">Retirer</button></li>`).join("") + `</ul>`;
  }
  $("#starred").innerHTML = html;
}

/* Mes artistes --------------------------------------------------------------- */

function renderArtists() {
  const q = fold(state.artistQ.trim());
  // Par niveau effectif (imposé ou calculé), puis par score : un artiste passé au niveau 3 descend
  const list = state.artists.filter((a) => !q || fold(a.name).includes(q))
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.name.localeCompare(b.name, "fr"));
  if (!state.artists.length) { $("#artists").innerHTML = emptyMessage(); return; }
  const tiers = [1, 2, 3].map((t) => state.artists.filter((a) => a.tier === t && a.still_liked !== false).length);
  const sync = state.apiError
    ? `<p class="prefs-warning">Vos préférences (niveaux imposés, artistes masqués) n'ont pas pu être lues : ${esc(state.apiError)}. Les niveaux affichés sont ceux du dernier traitement. Rechargez la page ; si le message persiste, signalez-le à l'admin.</p>`
    : "";
  let html = `${sync}<p class="count-line">${state.artists.length} artistes : ${tiers[0]} en niveau 1, ${tiers[1]} en niveau 2, ${tiers[2]} en niveau 3. Classés par niveau, puis par score.</p>
    <input type="search" id="artist-filter" class="artist-filter" placeholder="Filtrer vos artistes" aria-label="Filtrer vos artistes" value="${esc(state.artistQ)}">
    <div class="table-wrap"><table><thead><tr><th>Artiste</th><th>Niveau</th><th class="num">Score</th><th class="hide-mobile">Détail</th><th class="hide-mobile">Ajouté le</th></tr></thead><tbody>`;
  for (const a of list.slice(0, 1500)) {
    const s = a.sources || {};
    const detail = [s.favorite ? "favori" : "", s.albums ? `${s.albums} album${s.albums > 1 ? "s" : ""}` : "",
      s.tracks ? `${s.tracks} titre${s.tracks > 1 ? "s" : ""}` : "", s.playlists ? `${s.playlists} en playlist` : ""].filter(Boolean).join(", ");
    html += `<tr>
      <td>${a.picture ? `<img class="artist-thumb" src="${esc(a.picture)}" alt="" loading="lazy">` : ""}<a href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener" class="cell-name">${esc(a.name)}</a>${a.still_liked === false ? `<span class="cell-sub">Retiré de vos favoris</span>` : ""}${isHidden(a.name) ? `<span class="cell-sub">Masqué : concerts visibles seulement dans « Tous les concerts »</span>` : ""}
        <button type="button" class="link-btn" data-hide="${esc(a.name)}" data-hide-action="${isHidden(a.name) ? "unhide" : "hide"}">${isHidden(a.name) ? "Ne plus masquer" : "Masquer"}</button></td>
      <td><span class="tag tag-known tier-${a.tier}">Niveau ${a.tier}${state.levels.has(normName(a.name)) ? " · imposé" : ""}</span>
        <select class="tier-select" data-level="${esc(a.name)}" aria-label="Niveau de ${esc(a.name)}">
          <option value="">Calculé (${a.tier_auto ?? a.tier0})</option>
          ${[1, 2, 3].map((t) => `<option value="${t}"${state.levels.get(normName(a.name)) === t ? " selected" : ""}>Imposé : ${t}</option>`).join("")}
        </select></td>
      <td class="num">${a.score}</td>
      <td class="hide-mobile">${esc(detail)}</td>
      <td class="hide-mobile cell-date">${a.first_seen ? esc(fmt({ day: "numeric", month: "short", year: "numeric" }).format(parseDay(a.first_seen))) : ""}</td>
    </tr>`;
  }
  html += `</tbody></table></div>`;
  $("#artists").innerHTML = html;
}

/* Salles --------------------------------------------------------------------- */

function venueTable(rows, proposable = false) {
  let html = `<div class="table-wrap"><table><thead><tr><th>Salle</th><th class="num">Vos artistes</th><th class="num">Découvertes</th><th class="num hide-mobile">Concerts au total</th></tr></thead><tbody>`;
  for (const v of rows) {
    html += `<tr><td><button class="venue-name-btn" data-venue="${esc(v.name)}">${esc(v.name)}</button>${proposable && !v.venue_id
      ? ` <button type="button" class="link-btn" data-propose-venue="${esc(v.name)}">Proposer au catalogue</button>` : ""}</td>
      <td class="num">${v.known}</td><td class="num">${v.discovery}</td><td class="num hide-mobile">${v.total}</td></tr>`;
  }
  return html + `</tbody></table></div>`;
}

// Salles observées et vos concerts (préférences appliquées), triées par nombre de concerts retenus
function venueStats() {
  const venues = new Map();
  for (const ev of state.events) {
    if (!venues.has(ev.venue)) venues.set(ev.venue, { name: ev.venue, venue_id: null, total: 0, known: 0, discovery: 0, favorite: false });
    const v = venues.get(ev.venue);
    v.venue_id ||= ev.venue_id || null;
    v.total += 1;
    v.favorite ||= ev.venue_favorite;
    if (ev.kind === "known") v.known += 1;
    if (ev.kind === "discovery") v.discovery += 1;
  }
  return [...venues.values()].sort((a, b) => (b.known + b.discovery) - (a.known + a.discovery) || b.total - a.total
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function renderVenues() {
  const venues = venueStats();
  if (!venues.length) { $("#venues").innerHTML = emptyMessage(); return; }
  const favs = venues.filter((v) => v.favorite);
  const others = venues.filter((v) => !v.favorite && v.known + v.discovery > 0);
  $("#venues").innerHTML =
    `<h2 class="month-title">Vos salles</h2>${venueTable(favs)}
     <h2 class="month-title">D'autres salles où passent des artistes pour vous</h2>
     <p class="count-line">Classées par nombre de concerts retenus. Cliquez sur une salle pour voir sa programmation. Une salle absente du catalogue peut y être proposée : après validation par l'admin, chaque membre pourra la choisir comme favorite.</p>
     ${others.length ? venueTable(others, true) : `<p class="empty">Aucune autre salle pour l'instant.</p>`}
     <h2 class="month-title">Proposer une salle</h2>
     <form id="venue-proposal" class="account-form">
       <label for="proposal-name">Nom de la salle</label>
       <input id="proposal-name" type="text" maxlength="80" required>
       <label for="proposal-aliases">Autres noms utilisés par les billetteries (facultatif, séparés par des virgules)</label>
       <input id="proposal-aliases" type="text" maxlength="400">
       <label for="proposal-url">Page programme de la salle (facultatif)</label>
       <input id="proposal-url" type="url" maxlength="300" placeholder="https://">
       <button class="btn" type="submit">Proposer</button>
     </form>
     <div id="venue-proposals"></div>`;
  $("#venue-proposal").addEventListener("submit", (e) => { e.preventDefault(); proposeVenue(); });
  renderProposals();
}

const PROPOSAL_STATUS = { pending: "en attente de l'admin", approved: "ajoutée au catalogue", rejected: "refusée" };

// Propositions du membre et réponse de l'admin
async function renderProposals(list) {
  const box = $("#venue-proposals");
  if (!box) return;
  try { list = list || await api("venues/proposals"); } catch { return; }
  box.innerHTML = list.length ? `<h3>Vos propositions</h3><ul class="plain-list">${list.map((p) =>
    `<li>${esc(p.name)} : ${esc(PROPOSAL_STATUS[p.status] || p.status)}${p.review_note ? ` (${esc(p.review_note)})` : ""}</li>`).join("")}</ul>` : "";
}

async function proposeVenue() {
  const btn = $("#venue-proposal button[type=submit]");
  btn.disabled = true;
  try {
    const list = await api("venues/proposals", { method: "POST", body: {
      name: $("#proposal-name").value, aliases: $("#proposal-aliases").value, agenda_url: $("#proposal-url").value } });
    $("#venue-proposal").reset();
    toast("Salle proposée : l'admin la validera");
    renderProposals(list);
  } catch (e) {
    toast(e.message);
  }
  btn.disabled = false;
}

/* Billet détaillé ------------------------------------------------------------- */

function openTicket(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  const d = parseDay(ev.date);
  const dlg = $("#ticket");
  dlg.querySelector(".ticket").className = `ticket ${ev.kind}`;
  dlg.dataset.id = ev.id;  // concert affiché (« Remettre » rouvre la fiche)
  $("#ticket-stub").innerHTML = `
    <div><div class="ticket-day">${d.getDate()}</div>
    <div class="ticket-month">${esc(fmt({ month: "long", year: "numeric" }).format(d))}</div>
    <div class="ticket-weekday">${esc(fmt({ weekday: "long" }).format(d))}</div></div>
    ${ev.time ? `<div class="ticket-time">${esc(ev.time)}</div>` : ""}`;

  const sale = onSaleInfo(ev);
  const status = statusLabel(ev.status);
  let why = "";
  if (ev.kind === "known") {
    why = `<div class="ticket-section"><h3>Dans votre liste</h3><p>${ev.matched.map((m) =>
      `${m.link ? `<a href="${esc(safeUrl(m.link))}" target="_blank" rel="noopener">${esc(m.name)}</a>` : esc(m.name)} (niveau ${m.tier}${m.via === "titre" ? ", repéré dans le titre, à vérifier" : ""})`).join("<br>")}</p></div>`;
  } else if (ev.discovery) {
    const dc = ev.discovery;
    why = `<div class="ticket-section"><h3>Pourquoi cette découverte</h3>
      <p>Proche de ${esc(dc.close_to.join(", "))}. Proximité ${Math.round(dc.score * 100)} %${dc.fans ? `, ${dc.fans.toLocaleString("fr-FR")} fans sur Deezer` : ""}.</p></div>`;
  }
  const others = (ev.artists || []).filter((a) => fold(a) !== fold(headline(ev)));
  const hideable = ev.kind === "known" ? ev.matched.map((m) => m.name) : ev.kind === "discovery" ? [ev.discovery.artist] : [];
  const hideButtons = (isRemoved(ev) ? "" : `<button type="button" class="btn btn-quiet" data-remove="${esc(ev.id)}">Ne plus voir ce concert</button>`)
    + hideable.map((n) => `<button type="button" class="btn btn-quiet" data-hide="${esc(n)}" data-hide-action="hide">Ne plus recommander ${esc(n)}</button>`).join("");
  const links = (ev.links || []).map((l) => `<a class="btn" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">Voir sur ${esc(l.source)}</a>`).join("")
    // Fnac Spectacles bloque la lecture automatique : lien de recherche sur l'artiste
    + `<a class="btn btn-quiet" href="https://www.fnacspectacles.com/search/?searchterm=${encodeURIComponent(shareArtist(ev).name)}" target="_blank" rel="noopener">Chercher sur Fnac Spectacles</a>`;
  const listen = ev.kind === "discovery" && ev.discovery?.link
    ? `<a class="btn btn-secondary" href="${esc(safeUrl(ev.discovery.link))}" target="_blank" rel="noopener">Écouter sur Deezer</a>` : "";

  $("#ticket-body").innerHTML = `
    ${kindTag(ev, true)} ${badgeTag(ev)}
    <h2 id="ticket-title">${esc(headline(ev))}</h2>
    ${ev.title && normName(ev.title) !== normName(headline(ev)) ? `<p class="ticket-title-full">${esc(tidy(ev.title))}</p>` : ""}
    <div class="ticket-venue">${esc(ev.venue)}${ev.venue_favorite ? " (salle favorite)" : ""}</div>
    ${ev.address ? `<div class="ticket-address">${esc(tidy(ev.address))}${ev.city ? `, ${esc(tidy(ev.city))}` : ""}</div>` : ""}
    ${sale ? `<div class="ticket-section"><span class="ticket-sale">${esc(sale)}</span></div>` : ""}
    ${status ? `<div class="ticket-section"><p><strong>${esc(status)}</strong></p></div>` : ""}
    ${why}
    ${membersBlock(ev)}
    <div class="ticket-section loading" id="ticket-artist" data-id="${esc(ev.id)}"><h3>L'artiste</h3><p class="cell-sub">Chargement de la description…</p></div>
    ${others.length ? `<div class="ticket-section"><h3>À l'affiche également</h3><p>${esc(others.join(", "))}</p></div>` : ""}
    ${ev.price || ev.genre ? `<div class="ticket-section"><h3>Informations</h3><p>${[ev.price ? `Prix : ${esc(ev.price)}` : "", ev.genre ? `Genre : ${esc(ev.genre)}` : ""].filter(Boolean).join("<br>")}</p></div>` : ""}
    ${ev.description ? `<div class="ticket-section"><p>${esc(ev.description)}</p></div>` : ""}
    ${ev.image ? `<img class="ticket-image" src="${esc(ev.image)}" alt="" loading="lazy">` : ""}
    <div class="ticket-star" id="ticket-star">${starBlock(ev)}</div>
    <div class="ticket-links">${links}${listen}</div>
    <div class="ticket-share">
      <button type="button" class="btn btn-share" data-share="${esc(ev.id)}">Partager</button></div>
    ${hideButtons ? `<div class="ticket-hide">${hideButtons}</div>` : ""}`;
  if (!dlg.open) dlg.showModal();  // fiche rouverte après « Remettre »
  fillArtistSection(ev);
}

/* Rendu général --------------------------------------------------------------- */

function emptyMessage() {
  if (!state.meta.generated_at) {
    return `<div class="empty"><strong>Aucune donnée pour l'instant.</strong><br>
      Lancez le traitement depuis l'onglet Actions du dépôt GitHub (« Mise à jour hebdomadaire », puis « Run workflow »). La page se remplit à la fin du traitement.</div>`;
  }
  return `<div class="empty">Aucun résultat avec les filtres actuels. Élargissez les filtres.</div>`;
}

function render() {
  if (state.view === "calendar") renderCalendar();
  if (state.view === "list") renderList();
  if (state.view === "byartist") renderByArtist();
  if (state.view === "starred") renderStarred();
  if (state.view === "artists") renderArtists();
  if (state.view === "venues") renderVenues();
  if (state.view === "account") renderAccount();
  if (state.view === "admin") renderAdmin();
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== `view-${view}`));
  const eventFilters = view === "calendar" || view === "list";
  document.querySelectorAll("#filters .chip, #venue-filter").forEach((el) => (el.style.display = eventFilters ? "" : "none"));
  $("#style-filter").style.display = eventFilters || view === "byartist" ? "" : "none";
  if (!state.venue) $("#venue-filter").hidden = true;
  render();
  if (view === "calendar" && state.calendar) state.calendar.updateSize();
}

function bind() {
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  document.querySelectorAll("[data-kind]").forEach((cb) => cb.addEventListener("change", () => {
    cb.checked ? state.kinds.add(cb.dataset.kind) : state.kinds.delete(cb.dataset.kind);
    render();
  }));
  $("#all-concerts").addEventListener("change", (e) => {
    state.all = e.target.checked;
    document.querySelectorAll("[data-kind]").forEach((cb) => { cb.disabled = state.all; });
    render();
  });
  document.querySelectorAll("[data-cal]").forEach((b) => b.addEventListener("click", () => moveMonth(b.dataset.cal === "next" ? 1 : -1)));
  bindSwipe($("#calendar"));
  $("#byartist-sort").addEventListener("change", (e) => {
    state.byArtistSort = e.target.value;
    try { localStorage.setItem("byArtistSort", state.byArtistSort); } catch { /* stockage indisponible */ }
    render();
  });
  document.body.addEventListener("change", (e) => {
    const sel = e.target.closest(".tier-select");
    if (sel) setLevel(sel.dataset.level, sel.value ? Number(sel.value) : null);
    const share = e.target.closest("[data-star-share]");
    if (share) setStarOption(share.dataset.starId, "visibility", share.checked ? "members" : "private");
  });
  $("#fav-only").addEventListener("change", (e) => { state.favOnly = e.target.checked; render(); });
  $("#with-members").addEventListener("change", (e) => { state.withMembers = e.target.checked; render(); });
  $("#refresh").addEventListener("click", () => location.reload());
  $("#relogin").addEventListener("click", () => location.reload());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
  window.addEventListener("pageshow", (e) => { if (e.persisted) checkForUpdate(); });  // page restaurée depuis le cache (iOS)
  $("#style-filter").addEventListener("change", (e) => { state.style = e.target.value; render(); });
  // Filtre de « Mes artistes » : tableau seul redessiné, le champ garde la saisie
  let t;
  document.body.addEventListener("input", (e) => {
    if (e.target.id !== "artist-filter") return;
    clearTimeout(t);
    t = setTimeout(() => {
      state.artistQ = e.target.value;
      const typing = document.activeElement === e.target;
      const pos = e.target.selectionStart;
      renderArtists();
      if (!typing) return;  // focus parti ailleurs entre-temps : on ne le reprend pas
      const input = $("#artist-filter");
      input.focus();
      input.setSelectionRange(pos, pos);
    }, 150);
  });

  document.body.addEventListener("click", (e) => {
    const share = e.target.closest("[data-share]");
    if (share) { e.stopPropagation(); shareMessage(share.dataset.share); return; }
    const star = e.target.closest("[data-star]");
    if (star) { e.stopPropagation(); toggleStar(star.dataset.star); return; }
    const status = e.target.closest("[data-star-set]");
    if (status) {
      e.stopPropagation();
      // Autre statut : on passe de l'un à l'autre ; même statut, second clic : on décoche (retrait)
      if (state.starred.get(status.dataset.starId)?.status !== status.dataset.starSet) {
        setStarOption(status.dataset.starId, "status", status.dataset.starSet);
      } else {
        toggleStar(status.dataset.starId);
      }
      return;
    }
    const hide = e.target.closest("[data-hide]");
    if (hide) { e.stopPropagation(); setHidden(hide.dataset.hide, hide.dataset.hideAction !== "unhide"); return; }
    const remove = e.target.closest("[data-remove]");
    if (remove) { e.stopPropagation(); removeFromTicket(remove.dataset.remove); return; }
    const restore = e.target.closest("[data-restore]");
    if (restore) { e.stopPropagation(); restoreFromButton(restore.dataset.restore); return; }
    const row = e.target.closest("[data-id]");
    if (row && !e.target.closest("a")) { openTicket(row.dataset.id); return; }
    const propose = e.target.closest("[data-propose-venue]");
    if (propose) {
      $("#proposal-name").value = propose.dataset.proposeVenue;
      $("#venue-proposal").scrollIntoView({ behavior: "smooth", block: "center" });
      $("#proposal-aliases").focus();
      return;
    }
    const venue = e.target.closest("[data-venue]");
    if (venue) { setVenueFilter(venue.dataset.venue); switchView("list"); }
  });
  document.body.addEventListener("keydown", (e) => {
    const row = e.target.closest?.("tr[data-id]");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openTicket(row.dataset.id); }
  });
  // Section « Concerts retirés » : repliée ou dépliée, gardée d'un rendu à l'autre
  $("#removed").addEventListener("toggle", (e) => { state.removedOpen = e.target.open; }, true);
  const dlg = $("#ticket");
  $("#ticket-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
}

// « Ne plus voir ce concert » depuis la fiche : elle se ferme ; « Annuler » dans le message (ou dans
// la barre des Reels, la fiche ayant été ouverte depuis une fiche Reels)
let removing = false;  // un seul retrait à la fois (double clic)
async function removeFromTicket(id) {
  if (removing) return;
  removing = true;
  let undo;
  try {
    undo = await removeConcert(id);
  } catch (e) {
    toast(`Retrait impossible : ${e.message}`);
    return;
  } finally {
    removing = false;
  }
  if (!undo) return;
  const ev = state.events.find((e) => e.id === id);
  if ($("#ticket").open) $("#ticket").close();
  const text = "Concert retiré : retrouvez-le dans « Concerts retirés »";
  if ($("#reels").open) {
    dropCard(ev);  // sans attendre l'événement de fermeture de la fiche
    showUndo("Concert retiré", reelsUndo(ev, undo));
  }
  else toast(text, { label: "Annuler", run: () => undo().catch((e) => toast(`Annulation impossible : ${e.message}`)) });
}

async function restoreFromButton(concertId) {
  const shown = $("#ticket").open ? $("#ticket").dataset.id : null;
  try {
    await restoreConcert(concertId);
  } catch (e) {
    toast(`Enregistrement impossible : ${e.message}`);
    return;
  }
  if (shown) openTicket(shown);  // fiche ouverte : « Ne plus voir ce concert » réapparaît
}

// Lien d'une fiche /partage/ ouverte depuis la newsletter : ?concert=<id> ouvre la fiche du
// concert ; &star=interested l'ajoute aussi aux Intéressés (s'il n'y est pas déjà). L'adresse est
// ensuite nettoyée : un rechargement ne refait rien.
// L'ajout suit le réglage du membre (★ visibles par les membres par défaut), avec « Annuler »
// dans le message.
async function openFromLink({ onboarding = false } = {}) {
  const params = new URLSearchParams(location.search);
  const id = params.get("concert");
  if (!id) return;
  history.replaceState(null, "", location.pathname);
  if (onboarding) { toast("Ce lien s'ouvrira une fois votre compte prêt"); return; }
  if (state.loadFailed) { toast("Les concerts n'ont pas pu être chargés : rechargez la page"); return; }
  if (!state.events.some((e) => e.id === id)) { toast("Ce concert n'est plus à l'affiche"); return; }
  openTicket(id);
  if (params.get("star") !== "interested") return;
  if (isRemoved(state.events.find((e) => e.id === id))) { toast("Ce concert fait partie de vos concerts retirés"); return; }
  if (isStarred(id)) { toast("Déjà dans vos concerts"); return; }
  await setStarOption(id, "status", "interested");
  if (!isStarred(id)) return;
  const shared = state.starred.get(id).visibility === "members";
  toast(`Ajouté à vos concerts intéressés (${shared ? "visible par les membres" : "visible par vous seul"})`,
    { label: "Annuler", run: () => toggleStar(id) });
}

(async function init() {
  const common = Promise.all([loadJSON("events", []), loadJSON("meta", {})]);
  // Données du membre connecté : profil, concerts retenus pour lui, liste d'artistes, préférences
  const personal = Promise.all([api("me"), api("me/concerts"), api("me/artists")]).catch((e) => {
    state.loadFailed = true;
    state.apiError = e.message;
    state.accessError = e;
    return [null, { overlay: {}, meta: null }, {}];
  });
  const [[events, meta], [me, concerts, artists]] = await Promise.all([common, personal, loadPrefs(), loadSeen()]);
  Object.assign(state, {
    events: mergeOverlay(events || [], concerts.overlay || {}),
    meta: meta || {},
    memberMeta: concerts.meta || {},
    me,
    // Niveau enregistré : calculé à partir des likes ; le niveau imposé vient des préférences
    // Tri par score décroissant, comme le fichier publié avant la reprise (résolution des homonymes)
    artists: Object.values(artists || {}).map((a) => ({ ...a, tier_auto: a.tier }))
      .sort((a, b) => b.score - a.score || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0)),
  });
  state.profile = new Map(state.artists.map((a) => [normName(a.name), a]));
  // Nouveau membre : accueil (choix de la source), puis attente du premier calcul
  // Membre Spotify dont la demande est en attente ou l'accès à (re)connecter : même écran qu'à l'arrivée
  // Membre Spotify sans résultats dont la demande est en attente ou l'accès à connecter : écran d'arrivée
  const spotifyPending = me?.source?.provider === "spotify" && ["pending_allowlist", "ready_to_connect"].includes(me.source.status);
  if (me && (["invited", "onboarding"].includes(me.status) || (spotifyPending && !state.artists.length)
      || (me.status === "computing" && !state.artists.length))) {
    showOnboarding(me);
    openFromLink({ onboarding: true });
    return;
  }
  $("#tab-admin").hidden = me?.role !== "admin";
  applyPrefs();
  fillStyles();
  updateStarCount();
  bind();
  bindReels();
  bindSearch();
  renderMasthead();
  switchView("calendar");
  openFromLink();
  if (state.loadFailed) showAccessAlert(state.accessError);
  else if (!state.meta.generated_at) $("#calendar").insertAdjacentHTML("beforebegin", emptyMessage());
  // Retour de Spotify en erreur, accès Spotify expiré ou retiré (les concerts ne sont plus mis à jour)
  const revoked = me?.source?.provider === "spotify" && me.source.status === "revoked"
    ? `<p class="prefs-warning">L'accès de Concerts à votre compte Spotify a expiré ou a été retiré : vos concerts ne sont plus mis à jour. <a href="api/me/spotify/authorize">Reconnecter Spotify</a></p>`
    : spotifyPending ? `<p class="prefs-warning">Votre accès Spotify est à reconnecter : vos concerts ne sont plus mis à jour. Suite dans « Mon compte ».</p>` : "";
  // Dernier calcul en erreur (quota Spotify, profil devenu privé…) : explication et nouvel essai
  // prévu, au lieu d'un site vide ou de résultats anciens sans mot (version 1.9.0)
  const problem = !revoked && syncProblem(me);
  const syncBanner = problem
    ? `<p class="prefs-warning">${state.artists.length ? "Vos concerts n'ont pas pu être mis à jour" : "Vos concerts ne sont pas encore calculés"} : ${esc(problem)}.
      ${me.source.retry_at ? "Rien à faire de votre côté : vous recevrez un e-mail quand ce sera fait." : ""}
      <button type="button" class="link-btn inline-link" data-problem>J'ai un problème</button></p>` : "";
  $("#filters").insertAdjacentHTML("beforebegin", spotifyNotice() + revoked + syncBanner);
  // Lien d'un e-mail : ?vue=account (Mon compte) ou ?vue=admin
  const vue = new URLSearchParams(location.search).get("vue");
  if (vue && document.querySelector(`.tabs button[data-view="${CSS.escape(vue)}"]:not([hidden])`)) {
    history.replaceState(null, "", location.pathname);
    switchView(vue);
  }
})();
