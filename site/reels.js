"use strict";

// Fiches Reels en plein écran, ouvertes depuis les cercles de l'en-tête :
// - « Reels » : nouveautés de la semaine. Une fiche affichée est vue : elle ne réapparaît sur aucun
//   appareil (table D1 seen_cards, route /api/me/seen).
// - mois en cours et mois suivant (version 1.11.0) : concerts à venir de votre liste dans le mois,
//   par date ; un concert avec places prises n'y figure pas. Une fiche affichée ici compte aussi
//   comme vue pour les nouveautés (elle en sort).
//   Version 1.14.0 : un concert dépassé dans un mois (passage à la fiche suivante) n'y revient plus,
//   sur aucun appareil (table D1 month_seen, route /api/me/month-seen), distinct des nouveautés :
//   une fiche vue dans « NEW » reste dans son mois. « Tout revoir » sur l'écran de fin.
// Gestes : vers la gauche, fiche suivante ; vers la droite, précédente ; vers le bas, « Ne plus voir
// ce concert » (l'artiste reste recommandé ; Annuler pendant 6 s). Bouton « Ne plus recommander
// l'artiste » à part. Utilise les fonctions de app.js.

const reels = { seen: new Set(), pending: new Set(), loaded: false,
  queue: [], index: 0, timer: null, undo: null, undoState: null, busy: false,
  // Cercles des mois (version 1.14.0) : concert -> mois (AAAA-MM) ; envois en attente, en cours ;
  // monthGen change à chaque « Tout revoir » (une lecture partie avant est ignorée)
  monthSeen: new Map(), monthPending: new Map(), monthSending: new Map(), monthFlight: null, monthGen: 0,
  monthLoaded: false, monthTimer: null,
  mode: "new", initial: 0 };  // cercle ouvert : "new" (nouveautés), "m0" (mois en cours), "m1" (mois suivant)
const MONTH_OFFSET = { m0: 0, m1: 1 };

// Nouveautés de la semaine dans votre liste (vos artistes et découvertes), annonces d'abord
function freshEvents() {
  const rank = (e) => (e.badge === "annonce" ? 0 : 2) + (e.kind === "known" ? 0 : 1);
  return state.events.filter((e) => e.badge && e.kind !== "other" && !isRemoved(e))
    .sort((a, b) => rank(a) - rank(b) || a.date.localeCompare(b.date));
}

const unseenEvents = () => freshEvents().filter((e) => !reels.seen.has(e.id));

// Mois calendaire à Paris, décalé de offset mois : { key: "AAAA-MM", name: "Octobre" }
function monthOf(offset) {
  const [y, m] = todayIso().split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 15));
  const name = new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" }).format(d);
  return { key: d.toISOString().slice(0, 7), name: name.charAt(0).toUpperCase() + name.slice(1) };
}

// « d'octobre », « de novembre »
const ofMonth = (name) => (/^[aeiouy]/i.test(fold(name)) ? "d'" : "de ") + name.toLowerCase();

// Concerts du mois dans votre liste (vos artistes et découvertes), à venir, sans places prises ni
// concerts retirés, par date et heure, déjà parcourus compris
function monthAll(offset) {
  const { key } = monthOf(offset);
  const today = todayIso();
  return state.events.filter((e) => e.date.startsWith(key) && e.date >= today && e.kind !== "other"
      && !isRemoved(e) && state.starred.get(e.id)?.status !== "going")
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || "99:99").localeCompare(b.time || "99:99"));  // heure inconnue : en fin de journée
}

// Concerts du mois pas encore parcourus
const monthEvents = (offset) => monthAll(offset).filter((e) => !reels.monthSeen.has(e.id));

// Concerts qui ne sont plus à leur place dans la file : artiste masqué (« other »), concert retiré,
// et, dans un cercle de mois, places prises
const outOfQueue = (e) => e.kind === "other" || isRemoved(e) || (reels.mode !== "new" && state.starred.get(e.id)?.status === "going");

// File nettoyée, fiches précédentes comprises ; la fiche affichée, si elle part, est remplacée par
// la suivante (ou l'écran de fin)
function pruneQueue() {
  const keep = (e) => !outOfQueue(e);
  const before = reels.queue.slice(0, reels.index).filter(keep).length;
  reels.queue = reels.queue.filter(keep);
  reels.index = Math.min(before, reels.queue.length);
}

// Fiches vues lues sur le serveur, plus celles pas encore envoyées ; liste illisible : les fiches
// ne s'ouvrent pas (elles réapparaîtraient alors qu'elles ont été vues)
async function loadSeen() {
  try {
    // Union : une fiche vue ici dont l'envoi est en cours n'est pas oubliée
    reels.seen = new Set([...(await api("me/seen")), ...reels.seen, ...reels.pending]);
    reels.loaded = true;
  } catch {
    /* liste gardée telle quelle ; openReels réessaie */
  }
}

// Concerts parcourus dans les mois, lus sur le serveur, plus ceux pas encore envoyés ; liste
// illisible : les cercles des mois ne s'ouvrent pas (les concerts parcourus reviendraient)
// (lecture serveur seule, plus les envois locaux : un « Tout revoir » fait sur un autre appareil
// est bien repris)
async function loadMonthSeen() {
  const gen = reels.monthGen;
  try {
    const rows = await api("me/month-seen");
    if (gen !== reels.monthGen) return;  // « Tout revoir » pendant la lecture : liste déjà à jour
    reels.monthSeen = new Map([...rows.map((r) => [r.id, r.month]), ...reels.monthSending, ...reels.monthPending]);
    reels.monthLoaded = true;
  } catch {
    /* liste gardée telle quelle ; openReels réessaie */
  }
}

// Un seul envoi à la fois (reels.monthFlight), que « Tout revoir » attend avant d'effacer
function flushMonthSeen(keepalive = false) {
  clearTimeout(reels.monthTimer);
  if (reels.monthFlight || !reels.monthPending.size) return reels.monthFlight;
  reels.monthFlight = sendMonthSeen(keepalive).finally(() => { reels.monthFlight = null; });
  return reels.monthFlight;
}

async function sendMonthSeen(keepalive) {
  while (reels.monthPending.size) {
    const items = [...reels.monthPending].slice(0, 50).map(([id, month]) => ({ id, month }));
    items.forEach((it) => { reels.monthPending.delete(it.id); reels.monthSending.set(it.id, it.month); });
    try {
      await api("me/month-seen", { method: "POST", body: { items }, keepalive });
    } catch (e) {
      // Nouvel essai au prochain envoi, sauf requête refusée (elle le serait encore)
      if (e?.status !== 400) items.forEach((it) => { if (!reels.monthPending.has(it.id)) reels.monthPending.set(it.id, it.month); });
      return;
    } finally {
      items.forEach((it) => reels.monthSending.delete(it.id));
    }
  }
}

// Concert dépassé dans un cercle de mois : il n'y reviendra plus (il reste dans la file en cours,
// pour « précédente »)
function markMonthSeen(ev) {
  if (reels.monthSeen.has(ev.id)) return;
  const month = ev.date.slice(0, 7);
  reels.monthSeen.set(ev.id, month);
  reels.monthPending.set(ev.id, month);
  clearTimeout(reels.monthTimer);
  reels.monthTimer = setTimeout(flushMonthSeen, 800);
}

// « Tout revoir » : les concerts du mois reviennent dans son cercle, la file repart du début
async function resetMonth() {
  if (reels.mode === "new" || reels.busy) return;
  const offset = MONTH_OFFSET[reels.mode];
  const { key, name } = monthOf(offset);
  const ids = monthAll(offset).map((e) => e.id).filter((id) => reels.monthSeen.has(id)).slice(0, 500);
  reels.busy = true;
  reels.monthGen += 1;
  // Envoi en cours terminé d'abord, puis envois en attente de ce mois retirés : arrivés après la
  // remise à zéro, ils la déferaient
  clearTimeout(reels.monthTimer);
  await reels.monthFlight?.catch(() => {});
  const dropped = [...reels.monthPending].filter(([id, month]) => month === key || ids.includes(id));
  dropped.forEach(([id]) => reels.monthPending.delete(id));
  try {
    const rows = await api("me/month-seen", { method: "DELETE", body: { month: key, ids } });
    reels.monthSeen = new Map([...rows.map((r) => [r.id, r.month]), ...reels.monthPending]);
    reels.monthGen += 1;  // lecture partie pendant l'effacement : ignorée aussi
  } catch (e) {
    dropped.forEach(([id, month]) => reels.monthPending.set(id, month));
    showUndo(`Enregistrement impossible : ${e.message}`);
    return;
  } finally {
    reels.busy = false;
  }
  reels.queue = monthEvents(offset);
  reels.initial = reels.queue.length;
  reels.index = 0;
  renderReelsRing();
  showCard();
  showUndo(`Les concerts ${ofMonth(name)} sont de nouveau à voir`);
}

// Envoi groupé des fiches vues ; en cas d'échec, nouvel essai au prochain envoi
async function flushSeen(keepalive = false) {
  flushMonthSeen(keepalive);
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
    ? `NEW : voir ${left} nouveauté${left > 1 ? "s" : ""} de la semaine`
    : "NEW : toutes les nouveautés de la semaine ont été vues");
  renderMonthRings();
}

// Cercles des mois : nom du mois et nombre de concerts restant à voir ; « ✓ » quand tout a été
// parcouru ; grisés (mais visibles) sans concert. Masqués si les concerts n'ont pas pu être chargés.
function renderMonthRings() {
  for (const [mode, offset] of Object.entries(MONTH_OFFSET)) {
    const btn = $(`#reels-${mode}`);
    if (!btn) continue;
    const { name } = monthOf(offset);
    const total = monthAll(offset).length;
    const n = monthEvents(offset).length;
    btn.hidden = state.loadFailed;
    btn.classList.toggle("is-empty", !total);
    btn.classList.toggle("seen", Boolean(total) && !n);
    btn.querySelector(".reels-num").textContent = total && !n ? "✓" : String(n);
    btn.querySelector(".reels-label").textContent = name;
    btn.setAttribute("aria-label", n ? `${name} : voir ${n} concert${n > 1 ? "s" : ""} à venir`
      : total ? `${name} : tous les concerts ont été vus`
      : `${name} : aucun concert à venir dans votre liste`);
  }
}

async function openReels(mode = "new") {
  if ($("#reels").open) return;
  let queue;
  if (mode === "new") {
    if (!reels.loaded) await loadSeen();
    if (!reels.loaded) { toast("Les nouveautés déjà vues n'ont pas pu être lues : réessayez dans un instant"); return; }
    queue = unseenEvents();
    if (!queue.length) { toast("Toutes les nouveautés de la semaine ont été vues"); return; }
  } else {
    if (!reels.monthLoaded) await loadMonthSeen();
    if (!reels.monthLoaded) { toast("Les concerts déjà vus n'ont pas pu être lus : réessayez dans un instant"); return; }
    queue = monthEvents(MONTH_OFFSET[mode]);  // vide : écran « Tout est vu » ou « Aucun concert »
  }
  // Fiche concert ou autre cercle ouverts pendant la lecture des fiches vues : ils restent devant,
  // la file en cours n'est pas touchée
  if ($("#ticket").open || $("#reels").open) return;
  reels.queue = queue;
  reels.initial = queue.length;  // écran de fin : « Aucun concert » seulement si la file était vide
  reels.mode = mode;
  reels.index = 0;
  $("#reels").setAttribute("aria-label", mode === "new" ? "Nouveautés de la semaine" : `Concerts ${ofMonth(monthOf(MONTH_OFFSET[mode]).name)}`);
  $("#reels").showModal();
  pushLayer("reels");  // « retour » du téléphone ferme les Reels (version 1.9.2)
  showCard();
}

function closeReels() {
  if ($("#reels").open) $("#reels").close();
  dropLayer("reels");
}

function onReelsClosed() {
  // Annuler encore possible après la fermeture : proposé dans le message habituel
  const pending = reels.undoState;
  hideUndo();
  if (pending) toast(pending.text, { label: "Annuler", run: pending.run });
  flushSeen();
  renderReelsRing();
}

const hideableNames = (ev) => (ev.kind === "known" ? (ev.matched || []).map((m) => m.name)
  : ev.kind === "discovery" && ev.discovery ? [ev.discovery.artist] : []);

// « Intéressé » comme l'étoile ; concert déjà en « Places prises » : le bouton le montre, un clic le retire
function starReelLabel(ev) {
  const status = state.starred.get(ev.id)?.status;
  return { on: Boolean(status), text: status === "going" ? "✓ Places prises" : status ? "★ Intéressé" : "☆ Intéressé" };
}

function starReelButton(ev) {
  const { on, text } = starReelLabel(ev);
  return `<button type="button" class="btn btn-star${on ? " on" : ""}" data-reel="star" aria-pressed="${on}">${text}</button>`;
}

function cardHtml(ev) {
  const d = parseDay(ev.date);
  const sale = onSaleInfo(ev);
  return `<div class="reel-photo"></div>
    <div class="reel-body">
      <p class="reel-tags">${badgeTag(ev)} ${kindTag(ev, true)}</p>
      <h2 class="reel-title">${esc(headline(ev))}</h2>
      <p class="reel-when">${esc(fmt({ weekday: "long", day: "numeric", month: "long" }).format(d))}${ev.time ? ` · ${esc(ev.time)}` : ""}<br>${esc(ev.venue)}</p>
      ${sale ? `<p class="reel-sale">${esc(sale)}</p>` : ""}
      <div class="reel-about loading" id="reel-about"><p class="cell-sub">Chargement de la présentation…</p></div>
      <div class="reel-actions">
        ${starReelButton(ev)}
        <button type="button" class="btn btn-quiet" data-reel="remove">Ne plus voir ce concert</button>
        <button type="button" class="btn btn-quiet" data-reel="ticket">Voir la fiche</button>
        ${hideableNames(ev).length ? `<button type="button" class="link-btn reel-nope" data-reel="nope">Ne plus recommander ${hideableNames(ev).length > 1 ? "les artistes" : "l'artiste"}</button>` : ""}
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
  if (!box || $("#reel-card")?.dataset.reelId !== ev.id) return;  // fiche changée entre-temps
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
    card.dataset.reelId = "";
    card.className = "reel-card reel-end";
    const offset = MONTH_OFFSET[reels.mode];
    const name = reels.mode === "new" ? null : monthOf(offset).name;
    // Mois : « Tout est vu » s'il reste des concerts, tous parcourus ; « Aucun concert » sans
    // concert ; sinon (concert revenu pendant la lecture : places prises ou retrait annulés),
    // message neutre
    const total = name ? monthAll(offset).length : 0;
    const allSeen = total > 0 && !monthEvents(offset).length;
    const [title, sub] = !name ? ["Vous avez vu toutes les nouveautés de la semaine", "Les prochaines arriveront avec la mise à jour du lundi."]
      : allSeen ? [`Tout est vu pour ${name.toLowerCase()}`, "Les concerts ajoutés le lundi apparaîtront ici. Tous restent dans le calendrier."]
      : total ? [`Fin des concerts ${ofMonth(name)}`, "Rouvrez le cercle pour voir ceux qui restent."]
      : ["Aucun concert", `Aucun concert à venir en ${name.toLowerCase()} dans votre liste.`];
    card.innerHTML = `<div class="reel-body"><h2 class="reel-title">${esc(title)}</h2>
      <p class="reel-when">${esc(sub)}</p>
      <div class="reel-actions"><button type="button" class="btn btn-quiet" data-reel="close">Fermer</button>
        ${allSeen ? `<button type="button" class="link-btn reel-reset" data-reel="reset">Tout revoir</button>` : ""}</div></div>`;
    $("#reels-progress").style.width = reels.initial || allSeen ? "100%" : "0";
    $("#reels-position").textContent = "";
    focusCard();
    return;
  }
  card.dataset.reelId = ev.id;
  card.className = `reel-card ${ev.kind}`;
  card.style.transform = "";
  card.innerHTML = cardHtml(ev);
  setPhoto(ev.image);
  $("#reels-progress").style.width = `${((reels.index + 1) / reels.queue.length) * 100}%`;
  $("#reels-position").textContent = `${reels.index + 1} / ${reels.queue.length}`;
  markSeen(ev.id);
  fillAbout(ev);
  focusCard();
}

// Le focus reste dans la fenêtre des fiches (le bouton touché a disparu avec l'ancienne fiche)
function focusCard() {
  if ($("#reels").open && !$("#ticket").open) $("#reel-card").focus({ preventScroll: true });
}

function step(delta) {
  const next = reels.index + delta;
  if (next < 0 || next > reels.queue.length) return;
  // Mois : la fiche quittée vers la suivante est vue (pas en revenant en arrière)
  if (delta > 0 && reels.mode !== "new" && reels.queue[reels.index]) markMonthSeen(reels.queue[reels.index]);
  reels.index = next;
  showCard();
}

// « Ne plus voir ce concert » (geste vers le bas, flèche bas, bouton) : ce concert seulement, sans
// fenêtre de confirmation (sauf places prises) ; Annuler pendant 6 secondes
async function removeCard() {
  const ev = reels.queue[reels.index];
  if (!ev || reels.busy) return;  // un seul envoi à la fois (touche maintenue, double geste)
  reels.busy = true;
  let undo;
  try {
    undo = await removeConcert(ev.id);
  } catch (e) {
    showUndo(`Enregistrement impossible : ${e.message}`);
    return;
  } finally {
    reels.busy = false;
  }
  if (!undo) return;  // places prises : le membre a renoncé
  dropCard(ev);
  showUndo("Concert retiré", reelsUndo(ev, undo));
}

// Fiche retirée de la file (« précédente » ne la remontre pas) ; la fiche affichée reste la même,
// sauf si c'était celle-ci (la suivante prend sa place)
function dropCard(ev) {
  const i = reels.queue.indexOf(ev);
  if (i < 0) return;
  reels.queue.splice(i, 1);
  if (reels.index > i) reels.index -= 1;
  if ($("#reels").open) showCard();
}

// Annuler un retrait fait dans les Reels : le concert revient, et sa fiche aussi, à la place de la
// fiche affichée, si la fenêtre des fiches est encore ouverte
function reelsUndo(ev, undo) {
  return async () => {
    await undo();
    if (!ev || !$("#reels").open || reels.queue.includes(ev) || outOfQueue(ev)) return;  // ★ « places prises » rétablie : hors des mois
    const at = Math.min(reels.index, reels.queue.length);
    reels.queue.splice(at, 0, ev);
    reels.index = at;
    showCard();
  };
}

// « Ne plus recommander l'artiste » : le ou les artistes de la fiche, sans fenêtre de
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
  // Fiche retrouvée après l'envoi (l'index a pu changer) ; toutes les fiches des mêmes artistes,
  // précédentes comprises, sortent de la file (applyPrefs les a passées en « other »)
  reels.index = Math.max(0, reels.queue.indexOf(ev));
  pruneQueue();
  if (reels.queue[reels.index] === ev) reels.index += 1;  // fiche restée (cas imprévu) : la suivante
  showUndo(`${names.join(", ")} ne ${names.length > 1 ? "seront" : "sera"} plus recommandé${names.length > 1 ? "s" : ""}`, async () => {
    for (const name of names) {
      setPrefs(await api(`me/artists/${encodeURIComponent(normName(name))}`, { method: "PUT", body: { name, hidden: false } }));
    }
    afterPrefsChange();
    toast(`${names.join(", ")} de nouveau recommandé${names.length > 1 ? "s" : ""}`);
  });
  showCard();
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
  reels.undoState = action ? { text, run: () => action().catch((e) => toast(`Annulation impossible : ${e.message}`)) } : null;
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
  reels.undoState = null;
  const bar = $("#reels-undo");
  if (bar) { bar.hidden = true; bar.innerHTML = ""; }
}

// Gestes : la fiche suit le doigt. Glissement de 45 px, ou geste rapide de 20 px (30 px vers le
// bas, qui retire le concert). Toucher la photo : à droite fiche suivante, à gauche précédente.
function bindReelGestures(card) {
  let start = null;
  const reset = () => { start = null; card.classList.remove("dragging"); card.style.transform = ""; };
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button, a")) return;
    start = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, photo: Boolean(e.target.closest(".reel-photo")) };
    try { card.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
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
    else if (dy > Math.abs(dx) && (dy > 60 || (quick && dy > 30))) removeCard();
    else if (photo && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const box = card.getBoundingClientRect();
      step(e.clientX - box.left < box.width / 3 ? -1 : 1);
    }
  });
  card.addEventListener("pointercancel", reset);
}

function bindReels() {
  const dlg = $("#reels");
  for (const btn of document.querySelectorAll("[data-reels-mode]")) {
    btn.addEventListener("click", () => openReels(btn.dataset.reelsMode));
  }
  $("#reels-close").addEventListener("click", closeReels);
  dlg.addEventListener("close", onReelsClosed);
  dlg.addEventListener("click", (e) => {
    e.stopPropagation();  // aucun clic des fiches ne doit ouvrir une fiche concert en dessous
    const nav = e.target.closest("[data-reel-nav]");
    if (nav) { step(Number(nav.dataset.reelNav)); return; }
    const btn = e.target.closest("[data-reel]");
    if (!btn) return;
    if (btn.dataset.reel === "close") { closeReels(); return; }
    if (btn.dataset.reel === "reset") { resetMonth(); return; }
    const ev = reels.queue[reels.index];
    if (!ev) return;
    if (btn.dataset.reel === "star") {
      const update = () => {
        if ($("#reel-card").dataset.reelId !== ev.id) return;
        const { on, text } = starReelLabel(ev);
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on);
        btn.textContent = text;
      };
      toggleStar(ev.id).then(update);
      update();  // affichage immédiat, corrigé si l'enregistrement échoue
    } else if (btn.dataset.reel === "remove") removeCard();
    else if (btn.dataset.reel === "nope") notForMe();
    else if (btn.dataset.reel === "ticket") openTicket(ev.id);
  });
  // Clavier : écouté sur la page, pour garder les flèches après la fermeture d'une fiche concert
  document.addEventListener("keydown", (e) => {
    if (!dlg.open || $("#ticket").open || e.target.closest?.("input, select, textarea")) return;
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowDown") { e.preventDefault(); removeCard(); }
  });
  bindReelGestures($("#reel-card"));
  // Fiche du concert fermée (étoile, artiste masqué, concert retiré) : fiche Reels remise à jour ;
  // un concert retiré depuis sa fiche sort de la file
  $("#ticket").addEventListener("close", () => {
    if (!dlg.open) return;
    const ev = reels.queue[reels.index];
    pruneQueue();  // concert retiré, artiste masqué, places prises (mois) : fiches sorties de la file
    showCard();
  });
  // Fiches vues envoyées avant de quitter l'application
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSeen(true); });
}
