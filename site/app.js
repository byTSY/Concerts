"use strict";

const state = {
  events: [], artists: [], venues: [], meta: {},
  kinds: new Set(["known", "discovery"]), all: false, favOnly: false, venue: null, q: "",
  view: "calendar", calendar: null,
  hidden: new Set(), apiError: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const parseDay = (iso) => new Date(iso + "T12:00:00");
const fmt = (opts) => new Intl.DateTimeFormat("fr-FR", opts);
const fmtShort = fmt({ weekday: "short", day: "numeric", month: "short" });
const fmtMonth = fmt({ month: "long", year: "numeric" });
// Même normalisation que src/util.py (norm) et functions/api/hidden.js
const normName = (s) => String(s ?? "").replace(/['’‘`´]/g, " ").normalize("NFKD").replace(/[^\x00-\x7f]/g, "")
  .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim().replace(/^the /, "");
const isHidden = (name) => state.hidden.has(normName(name));

async function loadJSON(name, fallback) {
  try {
    const r = await fetch(`data/${name}.json`, { cache: "no-store" });
    return r.ok ? await r.json() : fallback;
  } catch { return fallback; }
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

/* Artistes masqués ------------------------------------------------------------ */

// Recalcule la catégorie affichée de chaque concert selon la liste des artistes masqués :
// un concert dont tous les artistes rapprochés sont masqués passe dans « Tous les concerts ».
function applyHidden() {
  for (const ev of state.events) {
    ev.kind0 ??= ev.kind;
    ev.matched0 ??= ev.matched;
    ev.tier0 ??= ev.tier;
    ev.kind = ev.kind0;
    if (ev.kind0 === "known") {
      ev.matched = (ev.matched0 || []).filter((m) => !isHidden(m.name));
      if (!ev.matched.length) ev.kind = "other";
      else ev.tier = Math.min(...ev.matched.map((m) => m.tier));
    } else if (ev.kind0 === "discovery" && isHidden(ev.discovery?.artist)) {
      ev.kind = "other";
    }
  }
}

async function loadHidden() {
  try {
    const r = await fetch("api/hidden", { cache: "no-store" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    state.hidden = new Set(data.hidden.map(normName));
  } catch (e) {
    // Site ouvert en local ou fonction Cloudflare non configurée : liste du dernier traitement
    state.apiError = e.message;
    state.hidden = new Set(state.artists.filter((a) => a.hidden).map((a) => normName(a.name)));
  }
}

async function setHidden(name, hide) {
  const question = hide
    ? `Ne plus recommander ${name} ?

Ses concerts sortiront de « Vos artistes » et des découvertes (ils resteront dans « Tous les concerts »). Vous pourrez annuler depuis l'onglet Mes artistes.`
    : `Recommander à nouveau ${name} ?`;
  if (!confirm(question)) return;
  try {
    const r = await fetch("api/hidden", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, action: hide ? "hide" : "unhide" }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    state.hidden = new Set(data.hidden.map(normName));
    state.apiError = null;
  } catch (e) {
    alert(`L'enregistrement a échoué : ${e.message}.

Le bouton ne fonctionne que sur le site publié, une fois la clé GitHub ajoutée dans Cloudflare.`);
    return;
  }
  applyHidden();
  if ($("#ticket").open) $("#ticket").close();
  renderMasthead();
  render();
  toast(hide ? `${name} ne sera plus recommandé` : `${name} est de nouveau recommandé`);
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 4000);
}

/* Filtres ------------------------------------------------------------------ */

function filtered() {
  const q = fold(state.q.trim());
  return state.events.filter((ev) => {
    if (!state.all && !state.kinds.has(ev.kind)) return false;
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
    $("#updated").textContent = `Mis à jour le ${fmt({ weekday: "long", day: "numeric", month: "long" }).format(d)}, ${m.counts?.artists ?? 0} artistes suivis`;
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
    title: `${headline(ev)} (${ev.venue})`,
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
      events: [],
    });
    state.calendar.render();
  }
  state.calendar.removeAllEvents();
  state.calendar.addEventSource(events);
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
        <td>${[kindTag(ev), badgeTag(ev)].filter(Boolean).join(" ")}</td>
      </tr>`;
    }
    html += `</tbody></table></div></div>`;
  }
  $("#list").innerHTML = html;
}

/* Mes artistes --------------------------------------------------------------- */

function renderArtists() {
  const q = fold(state.q.trim());
  const list = state.artists.filter((a) => !q || fold(a.name).includes(q));
  if (!state.artists.length) { $("#artists").innerHTML = emptyMessage(); return; }
  const tiers = [1, 2, 3].map((t) => state.artists.filter((a) => a.tier === t && a.still_liked !== false).length);
  let html = `<p class="count-line">${state.artists.length} artistes : ${tiers[0]} en niveau 1, ${tiers[1]} en niveau 2, ${tiers[2]} en niveau 3.</p>
    <div class="table-wrap"><table><thead><tr><th>Artiste</th><th>Niveau</th><th class="num">Score</th><th class="hide-mobile">Détail</th><th class="hide-mobile">Ajouté le</th></tr></thead><tbody>`;
  for (const a of list.slice(0, 1500)) {
    const s = a.sources || {};
    const detail = [s.favorite ? "favori" : "", s.albums ? `${s.albums} album${s.albums > 1 ? "s" : ""}` : "",
      s.tracks ? `${s.tracks} titre${s.tracks > 1 ? "s" : ""}` : "", s.playlists ? `${s.playlists} en playlist` : ""].filter(Boolean).join(", ");
    html += `<tr>
      <td>${a.picture ? `<img class="artist-thumb" src="${esc(a.picture)}" alt="" loading="lazy">` : ""}<a href="${esc(a.link)}" target="_blank" rel="noopener" class="cell-name">${esc(a.name)}</a>${a.still_liked === false ? `<span class="cell-sub">Retiré de vos favoris</span>` : ""}${isHidden(a.name) ? `<span class="cell-sub">Masqué : concerts visibles seulement dans « Tous les concerts »</span>` : ""}
        <button type="button" class="link-btn" data-hide="${esc(a.name)}" data-hide-action="${isHidden(a.name) ? "unhide" : "hide"}">${isHidden(a.name) ? "Ne plus masquer" : "Masquer"}</button></td>
      <td><span class="tag tag-known tier-${a.tier}">Niveau ${a.tier}</span></td>
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
    <div class="ticket-links">${links}${listen}</div>
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
  if (state.view === "artists") renderArtists();
  if (state.view === "venues") renderVenues();
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== `view-${view}`));
  const eventFilters = view === "calendar" || view === "list";
  document.querySelectorAll("#filters .chip, #venue-filter").forEach((el) => (el.style.display = eventFilters ? "" : "none"));
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
  $("#fav-only").addEventListener("change", (e) => { state.favOnly = e.target.checked; render(); });
  let t;
  $("#search").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; render(); }, 150); });

  document.body.addEventListener("click", (e) => {
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
  await loadHidden();
  applyHidden();
  bind();
  renderMasthead();
  switchView("calendar");
  if (!state.meta.generated_at) $("#calendar").insertAdjacentHTML("beforebegin", emptyMessage());
})();
