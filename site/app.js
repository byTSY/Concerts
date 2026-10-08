"use strict";

const state = {
  events: [], artists: [], venues: [], meta: {},
  kinds: new Set(["known", "discovery"]), all: false, favOnly: false, style: "", venue: null, q: "",
  view: "calendar", calendar: null,
  hidden: new Set(), levels: new Map(), starred: new Map(), profile: new Map(), apiError: null, loadFailed: false,
  byArtistSort: (() => { try { return localStorage.getItem("byArtistSort") || "date"; } catch { return "date"; } })(),
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const parseDay = (iso) => new Date(iso + "T12:00:00");
const fmt = (opts) => new Intl.DateTimeFormat("fr-FR", opts);
const fmtShort = fmt({ weekday: "short", day: "numeric", month: "short" });
const fmtMonth = fmt({ month: "long", year: "numeric" });
// Même normalisation que src/util.py (norm) et functions/api/prefs.js
const normName = (s) => String(s ?? "").replace(/['’‘`´]/g, " ").normalize("NFKD").replace(/[^\x00-\x7f]/g, "")
  .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim().replace(/^the /, "");
const isHidden = (name) => state.hidden.has(normName(name));

// Données publiées. Une connexion Cloudflare Access expirée renvoie vers la page de connexion :
// la requête échoue ou est redirigée, on le signale au lieu d'afficher une page vide.
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

// Retour sur l'application (raccourci d'écran d'accueil, onglet resté ouvert) : si de nouvelles
// données ont été publiées depuis l'ouverture, on recharge la page ; sinon on resynchronise les préférences.
async function checkForUpdate() {
  try {
    const r = await fetch("data/meta.json", { cache: "no-store" });
    if (r.redirected || !r.ok) throw new Error();
    const meta = await r.json();
    if (meta.generated_at && meta.generated_at !== state.meta.generated_at) { location.reload(); return; }
    await loadPrefs();
    applyPrefs();
    renderMasthead();
    render();
  } catch {
    $("#session-alert").hidden = false;
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
}

function setPrefs(data) {
  state.hidden = new Set((data.hidden || []).map(normName));
  state.levels = new Map(Object.entries(data.levels || {}).map(([n, t]) => [normName(n), Number(t)]));
  state.starred = new Map(Object.entries(data.starred || {}));
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

// Mise à jour immédiate de l'affichage, puis enregistrement ; retour en arrière si l'enregistrement échoue
async function toggleStar(id) {
  const ev = state.events.find((e) => e.id === id);
  const label = ev ? starLabel(ev) : state.starred.get(id) || id;
  const star = !isStarred(id);
  star ? state.starred.set(id, label) : state.starred.delete(id);
  refreshStars(id);
  try {
    const r = await fetch("api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(star ? { action: "star", id, label } : { action: "unstar", id }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    setPrefs(data);
    state.apiError = null;
    toast(star ? "Ajouté à vos concerts intéressés" : "Retiré de vos concerts intéressés");
  } catch (e) {
    star ? state.starred.delete(id) : state.starred.set(id, label);
    alert(`L'enregistrement a échoué : ${e.message}.\n\nCette fonction ne marche que sur le site publié.`);
  }
  refreshStars(id);
}

function refreshStars(id) {
  const ev = state.events.find((e) => e.id === id);
  if (ev && $("#ticket").open) {
    const btn = $("#ticket-body [data-star]");
    if (btn) btn.outerHTML = starButton(ev, true);
  }
  updateStarCount();
  if (state.view !== "calendar") render();
  else if (state.calendar) renderCalendar();
}

function updateStarCount() {
  const n = state.starred.size;
  $("#star-count").textContent = n ? ` (${n})` : "";
}

async function loadPrefs() {
  try {
    const r = await fetch("api/prefs", { cache: "no-store" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    setPrefs(data);
  } catch (e) {
    // Site ouvert en local ou fonction Cloudflare non configurée : préférences du dernier traitement
    state.apiError = e.message;
    setPrefs({
      hidden: state.artists.filter((a) => a.hidden).map((a) => a.name),
      levels: Object.fromEntries(state.artists.filter((a) => a.tier_auto && a.tier !== a.tier_auto).map((a) => [a.name, a.tier])),
    });
  }
}

async function savePref(body, done) {
  try {
    const r = await fetch("api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    setPrefs(data);
    state.apiError = null;
  } catch (e) {
    alert(`L'enregistrement a échoué : ${e.message}.\n\nCette fonction ne marche que sur le site publié, une fois la clé GitHub ajoutée dans Cloudflare.`);
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
  savePref({ name, action: hide ? "hide" : "unhide" },
    hide ? `${name} ne sera plus recommandé` : `${name} est de nouveau recommandé`);
}

function setLevel(name, level) {
  const key = normName(name);
  const upcoming = state.events.filter((ev) => (ev.matched0 || []).some((m) => normName(m.name) === key)).length;
  const effect = upcoming
    ? `${upcoming} concert${upcoming > 1 ? "s" : ""} à venir mis à jour`
    : "aucun concert à venir pour l'instant, le niveau s'appliquera aux prochains";
  savePref({ name, action: "level", level },
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
const genrePhrase = (ev) => GENRE_PHRASES.find(([re]) => re.test(normName(ev.genre || "")))?.[1] || null;
const hourText = (t) => t.replace(/^(\d+):(\d+)$/, (m, h, mn) => `${Number(h)}h${mn === "00" ? "" : mn}`);

function shareArtist(ev) {
  if (ev.kind === "known" && ev.matched?.length) return { name: ev.matched[0].name, link: ev.matched[0].link };
  if (ev.kind === "discovery" && ev.discovery) return { name: ev.discovery.artist, link: ev.discovery.link };
  return { name: tidy((ev.artists || [])[0] || ev.title), link: null };
}

function messageText(ev, info) {
  const artist = shareArtist(ev);
  const name = info?.artist || artist.name;
  const day = fmt({ weekday: "long", day: "numeric", month: "long" }).format(parseDay(ev.date));
  const when = `le ${day}${ev.time ? ` à ${hourText(ev.time)}` : ""}`;
  const style = genrePhrase(ev);
  // Première phrase de la description, pour rester court
  const desc = info?.description ? (info.description.match(/^.+?[.!?](\s|$)/)?.[0] || info.description).trim() : "";
  const lines = [
    `Hey, il y a le concert ${startsWithVowel(name) ? "d'" : "de "}${name} ${when}, ${atVenue(ev.venue)}.`,
    [style ? `C'est ${style}.` : "", desc].filter(Boolean).join(" "),
    "On prend des places ?",
    "",
    info?.listen?.deezer || artist.link || `https://www.deezer.com/search/${encodeURIComponent(name)}`,
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

async function shareMessage(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  let info = null;
  try {
    // Description de l'artiste et lien Deezer exact, préparés par la fiche de partage (2,5 s au plus)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`partage/${id}.json`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) info = await r.json();
  } catch { /* message sans description */ }
  await shareOrCopy({ text: messageText(ev, info) }, "Message copié : collez-le dans WhatsApp ou Messages");
}

async function sharePage(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  const url = new URL(`partage/${id}`, location.href).href;
  const day = fmt({ weekday: "long", day: "numeric", month: "long" }).format(parseDay(ev.date));
  await shareOrCopy({ title: `${shareArtist(ev).name}, ${day}`, url }, "Lien de la fiche copié");
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
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
  const q = fold(state.q.trim());
  return state.events.filter((ev) => {
    if (!state.all && !state.kinds.has(ev.kind)) return false;
    if (!styleOk(ev)) return false;
    if (state.favOnly && !ev.venue_favorite) return false;
    if (state.venue && ev.venue !== state.venue) return false;
    if (q) {
      const hay = fold([ev.title, ev.venue, headline(ev), (ev.artists || []).join(" ")].join(" "));
      if (!hay.includes(q)) return false;
    }
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
    $("#updated").textContent = `Mis à jour le ${fmt({ weekday: "long", day: "numeric", month: "long" }).format(d)} à ${fmt({ hour: "2-digit", minute: "2-digit" }).format(d)}, ${m.counts?.artists ?? 0} artistes suivis`;
  }
  // Bandeau : nouveautés de votre liste (vos artistes et découvertes) uniquement
  const fresh = state.events.filter((e) => e.badge && e.kind !== "other");
  const na = fresh.filter((e) => e.badge === "annonce").length;
  const nl = fresh.length - na;
  const parts = [];
  if (na) parts.push(`${na} nouvelle${na > 1 ? "s" : ""} annonce${na > 1 ? "s" : ""}`);
  if (nl) parts.push(`${nl} concert${nl > 1 ? "s" : ""} nouveau${nl > 1 ? "x" : ""} dans votre liste`);
  $("#fresh-title").textContent = !m.generated_at ? ""
    : m.initial ? `Base initiale : ${m.counts?.concerts ?? state.events.length} concerts enregistrés. Les nouveautés seront signalées à partir de la prochaine mise à jour.`
    : parts.length ? `${parts.join(" et ")} cette semaine`
    : "Aucune nouveauté cette semaine";
  const rank = (e) => (e.badge === "annonce" ? 0 : 2) + (e.kind === "known" ? 0 : 1);
  fresh.sort((a, b) => rank(a) - rank(b) || a.date.localeCompare(b.date));
  $("#stubs").innerHTML = fresh.slice(0, 30).map((ev) => {
    const d = parseDay(ev.date);
    const sale = onSaleInfo(ev);
    return `<button class="stub ${ev.kind} stub-${ev.badge}" data-id="${ev.id}">
      <span class="stub-date"><span class="stub-day">${d.getDate()}</span><span class="stub-month">${esc(fmt({ month: "short" }).format(d))}</span></span>
      <span class="stub-info"><span class="stub-name">${esc(headline(ev))}</span>
        <span class="stub-venue">${esc(ev.venue)}</span>
        <span class="stub-badge">${BADGES[ev.badge]}</span>
        ${sale ? `<span class="stub-sale">${esc(sale.replace("Mise en vente le ", "En vente le "))}</span>` : ""}</span>
    </button>`;
  }).join("");
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
        <td>${starButton(ev)} ${[kindTag(ev), badgeTag(ev)].filter(Boolean).join(" ")}</td>
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
    if (ev.kind !== "known" || !styleOk(ev)) continue;
    for (const m of ev.matched) {
      const key = normName(m.name);
      if (!rows.has(key)) {
        const p = profile.get(key) || {};
        rows.set(key, { name: m.name, tier: m.tier, link: m.link || p.link, picture: p.picture, added: p.added, events: [] });
      }
      rows.get(key).events.push(ev);
    }
  }
  const q = fold(state.q.trim());
  return [...rows.values()]
    .filter((r) => !q || fold(r.name).includes(q))
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
  if (!rows.length) { $("#byartist").innerHTML = `<div class="empty">Aucun de vos artistes ne correspond à la recherche.</div>`; return; }
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
  const items = [...state.starred].map(([id, label]) => ({ id, label, ev: state.events.find((e) => e.id === id) }));
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
    for (const { ev } of upcoming) {
      const sale = onSaleInfo(ev);
      const status = statusLabel(ev.status);
      const links = (ev.links || []).map((l) => `<a class="buy-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.source)}</a>`).join(" ");
      html += `<tr class="clickable" data-id="${ev.id}" tabindex="0">
        <td class="cell-date">${esc(fmtShort.format(parseDay(ev.date)))}${ev.time ? `<span class="cell-sub">${esc(ev.time)}</span>` : ""}</td>
        <td><span class="cell-name">${esc(headline(ev))}</span>${headline(ev) !== ev.title ? `<span class="cell-sub">${esc(ev.title)}</span>` : ""}</td>
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
  const q = fold(state.q.trim());
  // Par niveau effectif (imposé ou calculé), puis par score : un artiste passé au niveau 3 descend
  const list = state.artists.filter((a) => !q || fold(a.name).includes(q))
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.name.localeCompare(b.name, "fr"));
  if (!state.artists.length) { $("#artists").innerHTML = emptyMessage(); return; }
  const tiers = [1, 2, 3].map((t) => state.artists.filter((a) => a.tier === t && a.still_liked !== false).length);
  const sync = state.apiError
    ? `<p class="prefs-warning">Vos préférences (niveaux imposés, artistes masqués) n'ont pas pu être lues : ${esc(state.apiError)}. Les niveaux affichés sont ceux du dernier traitement. Rechargez la page ; si le message persiste, la clé GitHub est peut-être expirée dans Cloudflare.</p>`
    : "";
  let html = `${sync}<p class="count-line">${state.artists.length} artistes : ${tiers[0]} en niveau 1, ${tiers[1]} en niveau 2, ${tiers[2]} en niveau 3. Classés par niveau, puis par score.</p>
    <div class="table-wrap"><table><thead><tr><th>Artiste</th><th>Niveau</th><th class="num">Score</th><th class="hide-mobile">Détail</th><th class="hide-mobile">Ajouté le</th></tr></thead><tbody>`;
  for (const a of list.slice(0, 1500)) {
    const s = a.sources || {};
    const detail = [s.favorite ? "favori" : "", s.albums ? `${s.albums} album${s.albums > 1 ? "s" : ""}` : "",
      s.tracks ? `${s.tracks} titre${s.tracks > 1 ? "s" : ""}` : "", s.playlists ? `${s.playlists} en playlist` : ""].filter(Boolean).join(", ");
    html += `<tr>
      <td>${a.picture ? `<img class="artist-thumb" src="${esc(a.picture)}" alt="" loading="lazy">` : ""}<a href="${esc(a.link)}" target="_blank" rel="noopener" class="cell-name">${esc(a.name)}</a>${a.still_liked === false ? `<span class="cell-sub">Retiré de vos favoris</span>` : ""}${isHidden(a.name) ? `<span class="cell-sub">Masqué : concerts visibles seulement dans « Tous les concerts »</span>` : ""}
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

function venueTable(rows) {
  let html = `<div class="table-wrap"><table><thead><tr><th>Salle</th><th class="num">Vos artistes</th><th class="num">Découvertes</th><th class="num hide-mobile">Concerts au total</th></tr></thead><tbody>`;
  for (const v of rows) {
    html += `<tr><td><button class="venue-name-btn" data-venue="${esc(v.name)}">${esc(v.name)}</button></td>
      <td class="num">${v.known}</td><td class="num">${v.discovery}</td><td class="num hide-mobile">${v.total}</td></tr>`;
  }
  return html + `</tbody></table></div>`;
}

function renderVenues() {
  if (!state.venues.length) { $("#venues").innerHTML = emptyMessage(); return; }
  const favs = state.venues.filter((v) => v.favorite);
  const others = state.venues.filter((v) => !v.favorite && v.known + v.discovery > 0);
  $("#venues").innerHTML =
    `<h2 class="month-title">Vos salles</h2>${venueTable(favs)}
     <h2 class="month-title">D'autres salles où passent des artistes pour vous</h2>
     <p class="count-line">Classées par nombre de concerts retenus. Cliquez sur une salle pour voir sa programmation.</p>
     ${others.length ? venueTable(others) : `<p class="empty">Aucune autre salle pour l'instant.</p>`}`;
}

/* Billet détaillé ------------------------------------------------------------- */

function openTicket(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  const d = parseDay(ev.date);
  const dlg = $("#ticket");
  dlg.querySelector(".ticket").className = `ticket ${ev.kind}`;
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
      `${m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">${esc(m.name)}</a>` : esc(m.name)} (niveau ${m.tier}${m.via === "titre" ? ", repéré dans le titre, à vérifier" : ""})`).join("<br>")}</p></div>`;
  } else if (ev.discovery) {
    const dc = ev.discovery;
    why = `<div class="ticket-section"><h3>Pourquoi cette découverte</h3>
      <p>Proche de ${esc(dc.close_to.join(", "))}. Proximité ${Math.round(dc.score * 100)} %${dc.fans ? `, ${dc.fans.toLocaleString("fr-FR")} fans sur Deezer` : ""}.</p></div>`;
  }
  const others = (ev.artists || []).filter((a) => fold(a) !== fold(headline(ev)));
  const hideable = ev.kind === "known" ? ev.matched.map((m) => m.name) : ev.kind === "discovery" ? [ev.discovery.artist] : [];
  const hideButtons = hideable.map((n) => `<button type="button" class="btn btn-quiet" data-hide="${esc(n)}" data-hide-action="hide">Ne plus recommander ${esc(n)}</button>`).join("");
  const links = (ev.links || []).map((l) => `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener">Voir sur ${esc(l.source)}</a>`).join("");
  const listen = ev.kind === "discovery" && ev.discovery?.link
    ? `<a class="btn btn-secondary" href="${esc(ev.discovery.link)}" target="_blank" rel="noopener">Écouter sur Deezer</a>` : "";

  $("#ticket-body").innerHTML = `
    ${kindTag(ev, true)} ${badgeTag(ev)}
    <h2 id="ticket-title">${esc(headline(ev))}</h2>
    ${ev.title && ev.title !== headline(ev) ? `<p class="ticket-title-full">${esc(ev.title)}</p>` : ""}
    <div class="ticket-venue">${esc(ev.venue)}${ev.venue_favorite ? " (salle favorite)" : ""}</div>
    ${ev.address ? `<div class="ticket-address">${esc(ev.address)}${ev.city ? `, ${esc(ev.city)}` : ""}</div>` : ""}
    ${sale ? `<div class="ticket-section"><span class="ticket-sale">${esc(sale)}</span></div>` : ""}
    ${status ? `<div class="ticket-section"><p><strong>${esc(status)}</strong></p></div>` : ""}
    ${why}
    ${others.length ? `<div class="ticket-section"><h3>À l'affiche également</h3><p>${esc(others.join(", "))}</p></div>` : ""}
    ${ev.price || ev.genre ? `<div class="ticket-section"><h3>Informations</h3><p>${[ev.price ? `Prix : ${esc(ev.price)}` : "", ev.genre ? `Genre : ${esc(ev.genre)}` : ""].filter(Boolean).join("<br>")}</p></div>` : ""}
    ${ev.description ? `<div class="ticket-section"><p>${esc(ev.description)}</p></div>` : ""}
    ${ev.image ? `<img class="ticket-image" src="${esc(ev.image)}" alt="" loading="lazy">` : ""}
    <div class="ticket-links">${starButton(ev, true)}${links}${listen}</div>
    <div class="ticket-share"><h3>Partager</h3>
      <button type="button" class="btn btn-quiet" data-share="message" data-share-id="${esc(ev.id)}">Par message</button>
      <button type="button" class="btn btn-quiet" data-share="page" data-share-id="${esc(ev.id)}">Fiche web</button>
      <a class="link-btn share-preview" href="partage/${esc(ev.id)}" target="_blank" rel="noopener">Voir la fiche</a></div>
    ${hideButtons ? `<div class="ticket-hide">${hideButtons}</div>` : ""}`;
  dlg.showModal();
}

/* Rendu général --------------------------------------------------------------- */

function emptyMessage() {
  if (!state.meta.generated_at) {
    return `<div class="empty"><strong>Aucune donnée pour l'instant.</strong><br>
      Lancez le traitement depuis l'onglet Actions du dépôt GitHub (« Mise à jour hebdomadaire », puis « Run workflow »). La page se remplit à la fin du traitement.</div>`;
  }
  return `<div class="empty">Aucun résultat avec les filtres actuels. Élargissez les filtres ou effacez la recherche.</div>`;
}

function render() {
  if (state.view === "calendar") renderCalendar();
  if (state.view === "list") renderList();
  if (state.view === "byartist") renderByArtist();
  if (state.view === "starred") renderStarred();
  if (state.view === "artists") renderArtists();
  if (state.view === "venues") renderVenues();
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
  });
  $("#fav-only").addEventListener("change", (e) => { state.favOnly = e.target.checked; render(); });
  $("#refresh").addEventListener("click", () => location.reload());
  $("#relogin").addEventListener("click", () => location.reload());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
  window.addEventListener("pageshow", (e) => { if (e.persisted) checkForUpdate(); });  // page restaurée depuis le cache (iOS)
  $("#style-filter").addEventListener("change", (e) => { state.style = e.target.value; render(); });
  let t;
  $("#search").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; render(); }, 150); });

  document.body.addEventListener("click", (e) => {
    const share = e.target.closest("[data-share]");
    if (share) { e.stopPropagation(); (share.dataset.share === "page" ? sharePage : shareMessage)(share.dataset.shareId); return; }
    const star = e.target.closest("[data-star]");
    if (star) { e.stopPropagation(); toggleStar(star.dataset.star); return; }
    const hide = e.target.closest("[data-hide]");
    if (hide) { e.stopPropagation(); setHidden(hide.dataset.hide, hide.dataset.hideAction !== "unhide"); return; }
    const row = e.target.closest("[data-id]");
    if (row && !e.target.closest("a")) { openTicket(row.dataset.id); return; }
    const venue = e.target.closest("[data-venue]");
    if (venue) { setVenueFilter(venue.dataset.venue); switchView("list"); }
  });
  document.body.addEventListener("keydown", (e) => {
    const row = e.target.closest?.("tr[data-id]");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openTicket(row.dataset.id); }
  });
  const dlg = $("#ticket");
  $("#ticket-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
}

(async function init() {
  const [events, artists, venues, meta] = await Promise.all([
    loadJSON("events", []), loadJSON("artists", []), loadJSON("venues", []), loadJSON("meta", {}),
  ]);
  Object.assign(state, { events: events || [], artists: artists || [], venues: venues || [], meta: meta || {} });
  state.profile = new Map(state.artists.map((a) => [normName(a.name), a]));
  await loadPrefs();
  applyPrefs();
  fillStyles();
  updateStarCount();
  bind();
  renderMasthead();
  switchView("calendar");
  if (state.loadFailed) $("#session-alert").hidden = false;
  else if (!state.meta.generated_at) $("#calendar").insertAdjacentHTML("beforebegin", emptyMessage());
})();
