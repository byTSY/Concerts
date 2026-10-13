"use strict";

// Fiches Reels : nouveautés de la semaine en plein écran, ouvertes seulement depuis le cercle
// « Reels » de l'en-tête. Une fiche affichée est vue : elle ne réapparaît sur aucun appareil
// (table D1 seen_cards, route /api/me/seen).
// Gestes : vers la gauche, fiche suivante ; vers la droite, précédente ; vers le bas, « Pas pour
// moi » (Ne plus recommander l'artiste, avec Annuler pendant 6 s). Utilise les fonctions de app.js.

const reels = { seen: new Set(), pending: new Set(), queue: [], index: 0, timer: null, undo: null, busy: false };

// Nouveautés de la semaine dans votre liste (vos artistes et découvertes), annonces d'abord
function freshEvents() {
  const rank = (e) => (e.badge === "annonce" ? 0 : 2) + (e.kind === "known" ? 0 : 1);
  return state.events.filter((e) => e.badge && e.kind !== "other")
    .sort((a, b) => rank(a) - rank(b) || a.date.localeCompare(b.date));
}

const unseenEvents = () => freshEvents().filter((e) => !reels.seen.has(e.id));

async function loadSeen() {
  try {
    reels.seen = new Set(await api("me/seen"));
  } catch {
    reels.seen = new Set();  // liste illisible : les fiches restent proposées
  }
}

// Envoi groupé des fiches vues ; en cas d'échec, nouvel essai au prochain envoi
async function flushSeen(keepalive = false) {
  clearTimeout(reels.timer);
  if (!reels.pending.size) return;
  const ids = [...reels.pending].slice(0, 50);
  ids.forEach((id) => reels.pending.delete(id));
  try {
    await api("me/seen", { method: "POST", body: { ids }, keepalive });
  } catch {
    ids.forEach((id) => reels.pending.add(id));
    return;
  }
  if (reels.pending.size) flushSeen(keepalive);
}

function markSeen(id) {
  if (reels.seen.has(id)) return;
  reels.seen.add(id);
  reels.pending.add(id);
  clearTimeout(reels.timer);
  reels.timer = setTimeout(flushSeen, 800);
}

// Cercle de l'en-tête : anneau en couleur tant qu'il reste des fiches à voir
function renderReelsRing() {
  const btn = $("#reels-open");
  if (!btn) return;
  const fresh = freshEvents();
  const left = fresh.filter((e) => !reels.seen.has(e.id)).length;
  btn.hidden = !fresh.length;
  btn.classList.toggle("seen", !left);
  $("#reels-count").textContent = left ? String(left) : "✓";
  btn.setAttribute("aria-label", left
    ? `Voir ${left} nouveauté${left > 1 ? "s" : ""} de la semaine`
    : "Toutes les nouveautés de la semaine ont été vues");
}

function openReels() {
  reels.queue = unseenEvents();
  if (!reels.queue.length) { toast("Toutes les nouveautés de la semaine ont été vues"); return; }
  reels.index = 0;
  $("#reels").showModal();
  showCard();
}

function closeReels() {
  if ($("#reels").open) $("#reels").close();
}

function onReelsClosed() {
  hideUndo();
  flushSeen();
  renderReelsRing();
}

const hideableNames = (ev) => (ev.kind === "known" ? ev.matched.map((m) => m.name)
  : ev.kind === "discovery" && ev.discovery ? [ev.discovery.artist] : []);

function cardHtml(ev) {
  const d = parseDay(ev.date);
  const sale = onSaleInfo(ev);
  const on = isStarred(ev.id);
  return `<div class="reel-photo"></div>
    <div class="reel-body">
      <p class="reel-tags">${badgeTag(ev)} ${kindTag(ev, true)}</p>
      <h2 class="reel-title">${esc(headline(ev))}</h2>
      <p class="reel-when">${esc(fmt({ weekday: "long", day: "numeric", month: "long" }).format(d))}${ev.time ? ` · ${esc(ev.time)}` : ""}<br>${esc(ev.venue)}</p>
      ${sale ? `<p class="reel-sale">${esc(sale)}</p>` : ""}
      <div class="reel-about loading" id="reel-about"><p class="cell-sub">Chargement de la présentation…</p></div>
      <div class="reel-actions">
        <button type="button" class="btn btn-star${on ? " on" : ""}" data-reel="star" aria-pressed="${on}">${on ? "★ Intéressé" : "☆ Intéressé"}</button>
        ${hideableNames(ev).length ? `<button type="button" class="btn btn-quiet" data-reel="nope">Pas pour moi</button>` : ""}
        <button type="button" class="btn btn-quiet" data-reel="ticket">Voir la fiche</button>
      </div>
    </div>`;
}

// Photo en fond : adresse https uniquement ; guillemets, parenthèses, barres obliques inverses et
// espaces encodés, pour qu'aucune adresse ne sorte de url("…")
function setPhoto(url) {
  const box = $("#reel-card .reel-photo");
  const u = String(url || "");
  if (!box || !/^https:\/\//.test(u)) return;
  const safe = u.replace(/["'()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  box.style.backgroundImage = `url("${safe}")`;
}

// Présentation reprise de la page /partage/ : photo Deezer, description Wikidata et artistes similaires
async function fillAbout(ev) {
  const info = await artistInfo(ev.id);
  const box = $("#reel-about");
  if (!box || $("#reel-card")?.dataset.id !== ev.id) return;  // fiche changée entre-temps
  if (info?.picture) setPhoto(info.picture);
  const tags = (info?.genres || []).slice(0, 3).map((g) => `<span class="tag tag-genre">${esc(g)}</span>`).join(" ");
  box.innerHTML = info && (info.description || tags)
    ? `${tags ? `<p class="artist-genres">${tags}</p>` : ""}${info.description ? `<p>${esc(info.description)}</p>` : ""}`
    : "";
  box.classList.remove("loading");
}

function showCard() {
  const ev = reels.queue[reels.index];
  const card = $("#reel-card");
  if (!ev) {
    // Fin de la file : écran de fin (la barre Annuler reste utilisable)
    card.dataset.id = "";
    card.className = "reel-card reel-end";
    card.innerHTML = `<div class="reel-body"><h2 class="reel-title">Vous avez vu toutes les nouveautés de la semaine</h2>
      <p class="reel-when">Les prochaines arriveront avec la mise à jour du lundi.</p>
      <div class="reel-actions"><button type="button" class="btn btn-quiet" data-reel="close">Fermer</button></div></div>`;
    $("#reels-progress").style.width = "100%";
    $("#reels-position").textContent = "";
    return;
  }
  card.dataset.id = ev.id;
  card.className = `reel-card ${ev.kind}`;
  card.style.transform = "";
  card.innerHTML = cardHtml(ev);
  setPhoto(ev.image);
  $("#reels-progress").style.width = `${((reels.index + 1) / reels.queue.length) * 100}%`;
  $("#reels-position").textContent = `${reels.index + 1} / ${reels.queue.length}`;
  markSeen(ev.id);
  fillAbout(ev);
}

function step(delta) {
  const next = reels.index + delta;
  if (next < 0 || next > reels.queue.length) return;
  reels.index = next;
  showCard();
}

// « Pas pour moi » : Ne plus recommander le ou les artistes de la fiche, sans fenêtre de
// confirmation ; Annuler pendant 6 secondes
async function notForMe() {
  const ev = reels.queue[reels.index];
  if (!ev || reels.busy) return;  // un seul envoi à la fois (touche maintenue, double geste)
  const names = hideableNames(ev);
  if (!names.length) { step(1); return; }
  reels.busy = true;
  try {
    for (const name of names) {
      setPrefs(await api(`me/artists/${encodeURIComponent(normName(name))}`, { method: "PUT", body: { name, hidden: true } }));
    }
  } catch (e) {
    showUndo(`Enregistrement impossible : ${e.message}`);
    return;
  } finally {
    afterPrefsChange();  // affiche aussi un premier artiste masqué si le second échoue
    reels.busy = false;
  }
  // Fiche retrouvée après l'envoi (l'index a pu changer) ; les fiches suivantes des mêmes
  // artistes sortent de la file (applyPrefs les a passées en « other »)
  const i = Math.max(0, reels.queue.indexOf(ev));
  reels.queue = reels.queue.filter((e, j) => j <= i || e.kind !== "other");
  showUndo(`${names.join(", ")} ne ${names.length > 1 ? "seront" : "sera"} plus recommandé${names.length > 1 ? "s" : ""}`, async () => {
    for (const name of names) {
      setPrefs(await api(`me/artists/${encodeURIComponent(normName(name))}`, { method: "PUT", body: { name, hidden: false } }));
    }
    afterPrefsChange();
    toast(`${names.join(", ")} de nouveau recommandé${names.length > 1 ? "s" : ""}`);
  });
  reels.index = i;
  step(1);
}

function afterPrefsChange() {
  state.apiError = null;
  applyPrefs();
  renderMasthead();
  render();
}

// Barre « Annuler » dans la fenêtre des fiches (le message habituel resterait derrière elle)
function showUndo(text, action) {
  hideUndo();
  const bar = $("#reels-undo");
  bar.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button" class="link-btn" id="reels-undo-btn">Annuler</button>` : ""}`;
  bar.hidden = false;
  if (action) {
    $("#reels-undo-btn").addEventListener("click", async () => {
      hideUndo();
      try { await action(); } catch (e) { toast(`Annulation impossible : ${e.message}`); }
    }, { once: true });
  }
  reels.undo = setTimeout(hideUndo, 6000);
}

function hideUndo() {
  clearTimeout(reels.undo);
  const bar = $("#reels-undo");
  if (bar) { bar.hidden = true; bar.innerHTML = ""; }
}

// Gestes : la fiche suit le doigt. Glissement de 45 px, ou geste rapide de 20 px (30 px vers le
// bas, qui masque l'artiste). Toucher la photo : à droite fiche suivante, à gauche précédente.
function bindReelGestures(card) {
  let start = null;
  const reset = () => { start = null; card.classList.remove("dragging"); card.style.transform = ""; };
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, a")) return;
    start = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, photo: Boolean(e.target.closest(".reel-photo")) };
    card.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
  });
  card.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    card.style.transform = Math.abs(dx) > Math.abs(dy) ? `translateX(${dx}px) rotate(${dx / 30}deg)` : `translateY(${Math.max(0, dy)}px)`;
  });
  card.addEventListener("pointerup", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    const quick = Date.now() - start.t < 250;
    const { photo } = start;
    reset();
    if (Math.abs(dx) > Math.abs(dy) && (Math.abs(dx) > 45 || (quick && Math.abs(dx) > 20))) step(dx < 0 ? 1 : -1);
    else if (dy > Math.abs(dx) && (dy > 60 || (quick && dy > 30))) notForMe();
    else if (photo && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const box = card.getBoundingClientRect();
      step(e.clientX - box.left < box.width / 3 ? -1 : 1);
    }
  });
  card.addEventListener("pointercancel", reset);
}

function bindReels() {
  const dlg = $("#reels");
  $("#reels-open").addEventListener("click", openReels);
  $("#reels-close").addEventListener("click", closeReels);
  dlg.addEventListener("close", onReelsClosed);
  dlg.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-reel-nav]");
    if (nav) { step(Number(nav.dataset.reelNav)); return; }
    const btn = e.target.closest("[data-reel]");
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.reel === "close") { closeReels(); return; }
    const ev = reels.queue[reels.index];
    if (!ev) return;
    if (btn.dataset.reel === "star") {
      toggleStar(ev.id).then(() => {
        if ($("#reel-card").dataset.id !== ev.id) return;
        const on = isStarred(ev.id);
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on);
        btn.textContent = on ? "★ Intéressé" : "☆ Intéressé";
      });
    } else if (btn.dataset.reel === "nope") notForMe();
    else if (btn.dataset.reel === "ticket") openTicket(ev.id);
  });
  dlg.addEventListener("keydown", (e) => {
    if ($("#ticket").open) return;
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowDown") { e.preventDefault(); notForMe(); }
  });
  bindReelGestures($("#reel-card"));
  // Fiche du concert fermée (étoile, artiste masqué) : fiche Reels remise à jour
  $("#ticket").addEventListener("close", () => { if (dlg.open) showCard(); });
  // Fiches vues envoyées avant de quitter l'application
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSeen(true); });
}
