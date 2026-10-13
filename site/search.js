"use strict";

// Recherche sur tout le catalogue publié (events.json déjà chargé), sans tenir compte des filtres,
// concerts non recommandés compris ; une ligne par date. Depuis un résultat : « Intéressé » ou
// « Places prises » (statut going des ★). Section « Mes prochains concerts » : concerts à venir
// avec places prises, du plus proche au plus lointain. Utilise les fonctions de app.js.

const SEARCH_MAX = 60;
// Date du jour à Paris, AAAA-MM-JJ
const todayIso = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const nameOf = (ev) => headline(ev) || ev.title || "Concert sans titre";

// Texte cherché d'un concert : titre, artistes, salle, artistes rapprochés et découverte
function searchText(ev) {
  return fold([ev.title, ev.venue, (ev.artists || []).join(" "),
    (ev.matched0 || ev.matched || []).map((m) => m.name).join(" "), ev.discovery?.artist || ""].join(" "));
}

function searchEvents(query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length || words.join("").length < 2) return [];
  const today = todayIso();
  return state.events
    .filter((ev) => ev.date >= today && words.every((w) => (ev.searchText ??= searchText(ev)).includes(w)))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
}

// Concert non recommandé : artiste masqué (« Ne plus recommander »), repéré dans le concert
// (artistes, rapprochement du calcul) ou comme mots entiers du titre (« GIMS PLENITUDE ARENA »)
function hiddenArtistIn(ev) {
  if (!state.hidden.size) return false;
  const names = [...(ev.artists || []), ...(ev.matched0 || []).map((m) => m.name), ev.discovery?.artist || ""];
  if (names.some((n) => n && isHidden(n))) return true;
  // Titre : seulement les noms d'au moins 4 lettres ou de plusieurs mots (« Air », « M » trop courants)
  const title = ` ${normName(ev.title)} `;
  return [...state.hidden].some((key) => (key.length >= 4 || key.includes(" ")) && title.includes(` ${key} `));
}

function searchTag(ev) {
  if (ev.kind !== "other") return kindTag(ev);
  return hiddenArtistIn(ev) ? `<span class="tag tag-other">Non recommandé</span>` : "";
}

function statusButtons(ev) {
  const s = state.starred.get(ev.id)?.status;
  const choice = (status, off, on) => `<button type="button" class="btn btn-star btn-small${s === status ? " on" : ""}"
    data-star-set="${status}" data-star-id="${esc(ev.id)}" aria-pressed="${s === status}">${s === status ? on : off}</button>`;
  return choice("interested", "☆ Intéressé", "★ Intéressé") + choice("going", "🎟 Places prises", "✓ Places prises");
}

function renderSearch() {
  const box = $("#search-results");
  if (!box) return;
  const q = state.q.trim();
  const count = $("#search-count"), list = $("#search-list");  // zone d'annonce gardée d'un rendu à l'autre
  if (!q) { box.hidden = true; count.textContent = ""; list.innerHTML = ""; return; }
  const found = searchEvents(q);
  box.hidden = false;
  if (!found.length) {
    count.textContent = q.length < 2 ? "Tapez au moins deux lettres." : `Aucun concert à venir ne correspond à « ${q} ».`;
    list.innerHTML = "";
    return;
  }
  const shown = found.slice(0, SEARCH_MAX);
  // Bouton touché avant le nouveau rendu : le focus y revient (changement de statut au clavier)
  const active = document.activeElement?.closest?.("#search-results [data-star-set]");
  const refocus = active && `[data-star-id="${CSS.escape(active.dataset.starId)}"][data-star-set="${active.dataset.starSet}"]`;
  count.textContent = `${found.length} concert${found.length > 1 ? "s" : ""} à venir${found.length > SEARCH_MAX ? `, ${SEARCH_MAX} premiers affichés : précisez la recherche` : ""}.`;
  list.innerHTML = `${shown.map((ev) => `<li class="search-item">
      <button type="button" class="search-main" data-id="${esc(ev.id)}">
        <span class="search-date">${esc(fmtShort.format(parseDay(ev.date)))}${ev.time ? ` · ${esc(ev.time)}` : ""}</span>
        <span class="cell-name">${esc(nameOf(ev))}</span>
        ${ev.title && fold(nameOf(ev)) !== fold(ev.title) ? `<span class="cell-sub">${esc(ev.title)}</span>` : ""}
        <span class="cell-sub">${esc(ev.venue)} ${searchTag(ev)}</span>
      </button>
      <span class="search-actions">${statusButtons(ev)}</span>
    </li>`).join("")}`;
  if (refocus) box.querySelector(refocus)?.focus();
}

// Mes prochains concerts : places prises, à venir, du plus proche au plus lointain
function renderUpcoming() {
  const box = $("#upcoming");
  if (!box) return;
  const today = todayIso();
  const list = [...state.starred].filter(([, s]) => s.status === "going")
    .map(([id]) => state.events.find((e) => e.id === id))
    .filter((ev) => ev && ev.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
  box.hidden = !list.length;
  box.innerHTML = list.length ? `<h2 class="upcoming-title">Mes prochains concerts</h2>
    <ul class="upcoming-list">${list.map((ev) => `<li><button type="button" class="upcoming-item" data-id="${esc(ev.id)}">
      <span class="upcoming-date">${esc(fmtShort.format(parseDay(ev.date)))}${ev.time ? ` · ${esc(ev.time)}` : ""}</span>
      <span class="cell-name">${esc(nameOf(ev))}</span>
      <span class="cell-sub">${esc(ev.venue)}</span>
    </button></li>`).join("")}</ul>` : "";
}

function bindSearch() {
  const input = $("#search");
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = input.value; renderSearch(); }, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; state.q = ""; renderSearch(); }
  });
}
