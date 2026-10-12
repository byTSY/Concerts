"use strict";
// Arrivée d'un membre (choix et vérification de la source, salles favorites, attente du premier
// calcul) et onglet « Mon compte ». Utilise les fonctions de app.js ($, esc, api, toast, fmt).

const fmtDateTime = (iso) => {
  if (!iso) return "jamais";
  const d = new Date(iso);
  return isNaN(d) ? "jamais" : `${fmt({ weekday: "long", day: "numeric", month: "long" }).format(d)} à ${fmt({ hour: "2-digit", minute: "2-digit" }).format(d)}`;
};

const SYNC_STATUS = {
  ok: "réussie",
  private_profile: "profil Deezer devenu privé : rendez-le public dans les paramètres de confidentialité de Deezer",
  not_found: "profil Deezer introuvable",
  deezer_unavailable: "Deezer n'a pas répondu, nouvel essai au prochain calcul",
  storage_quota: "stockage plein, l'admin est prévenu",
  internal: "erreur interne, l'admin est prévenu",
};
const syncText = (code) => SYNC_STATUS[code] || (code ? `erreur (${code})` : "");

/* Arrivée ----------------------------------------------------------------------------- */

// Écran plein à la place du site : choix de la source, puis attente du premier calcul
function showOnboarding(me) {
  document.body.classList.add("onboarding-mode");
  const box = $("#onboarding");
  box.hidden = false;
  if (me.status === "computing") return renderWaiting(box, me);
  box.innerHTML = `
    <h2>Bienvenue, ${esc(me.display_name)}</h2>
    <p>Concerts à Paris repère les concerts de vos artistes et vous propose des découvertes proches de vos goûts, à partir de votre bibliothèque musicale.</p>
    <p class="cell-sub">Données conservées : votre adresse e-mail, votre prénom ou pseudo, votre source musicale, vos préférences et vos concerts mis de côté. Vous pouvez supprimer votre compte à tout moment depuis « Mon compte » ; tout est alors effacé.</p>
    <h3>1. Votre source musicale</h3>
    <div class="source-choice">
      <label class="source-option"><input type="radio" name="source" value="deezer" checked> <strong>Deezer</strong></label>
      <label class="source-option disabled"><input type="radio" name="source" value="spotify" disabled> <strong>Spotify</strong> <span class="cell-sub">bientôt disponible</span></label>
    </div>
    <form id="deezer-form" class="account-form">
      <label for="deezer-profile">Lien de votre profil Deezer, ou son n°</label>
      <input id="deezer-profile" type="text" inputmode="url" autocomplete="off" placeholder="https://www.deezer.com/fr/profile/123456789" required>
      <p class="cell-sub">Sur deezer.com, ouvrez votre page de profil : son adresse contient votre n°. Dans l'application : votre profil, Partager, Copier le lien. Votre profil doit être public (paramètres de confidentialité de Deezer). Aucun mot de passe n'est demandé.</p>
      <button class="btn" type="submit">Vérifier</button>
    </form>
    <div id="deezer-preview"></div>`;
  $("#deezer-form").addEventListener("submit", (e) => { e.preventDefault(); checkDeezer(); });
}

async function checkDeezer() {
  const profile = $("#deezer-profile").value.trim();
  const out = $("#deezer-preview");
  out.innerHTML = `<p class="cell-sub">Vérification…</p>`;
  try {
    const p = await api("me/source/deezer", { method: "POST", body: { profile } });
    out.innerHTML = `<div class="preview-card">
        ${p.picture ? `<img class="artist-thumb" src="${esc(p.picture)}" alt="">` : ""}
        <div><strong>${esc(p.name)}</strong><br><span class="cell-sub">${p.favorites} artiste${p.favorites > 1 ? "s" : ""} en favori</span></div>
      </div>
      <p>Est-ce bien votre profil ?</p>
      <button class="btn" type="button" id="deezer-confirm">Oui, utiliser ce profil</button>`;
    $("#deezer-confirm").addEventListener("click", () => confirmDeezer(profile));
  } catch (e) {
    out.innerHTML = `<p class="prefs-warning">${esc(e.message)}</p>`;
  }
}

async function confirmDeezer(profile) {
  const btn = $("#deezer-confirm");
  btn.disabled = true;
  try {
    const me = await api("me/source/deezer/confirm", { method: "POST", body: { profile } });
    await renderVenueChoice($("#onboarding"), me);
  } catch (e) {
    btn.disabled = false;
    $("#deezer-preview").insertAdjacentHTML("beforeend", `<p class="prefs-warning">${esc(e.message)}</p>`);
  }
}

// Étape facultative pendant le calcul : salles favorites
async function renderVenueChoice(box, me) {
  const venues = await api("venues").catch(() => []);
  const chosen = new Set(me.favorite_venues || []);
  box.innerHTML = `
    <h2>Votre profil est relié</h2>
    <p>Le calcul de vos concerts est lancé ; il prend quelques minutes.</p>
    <h3>2. Vos salles favorites (facultatif)</h3>
    <p class="cell-sub">Leurs concerts sont signalés et un peu favorisés dans les découvertes. Modifiable plus tard dans « Mon compte ».</p>
    <div class="venue-checks">${venueChecks(venues, chosen)}</div>
    <button class="btn" type="button" id="venues-done">Continuer</button>`;
  bindVenueChecks(box);
  $("#venues-done").addEventListener("click", () => renderWaiting(box, me));
}

function venueChecks(venues, chosen) {
  return venues.filter((v) => !v.excluded).map((v) =>
    `<label class="chip"><input type="checkbox" data-fav-venue="${esc(v.id)}"${chosen.has(v.id) ? " checked" : ""}> ${esc(v.name)}</label>`).join(" ");
}

function bindVenueChecks(box) {
  box.querySelectorAll("[data-fav-venue]").forEach((cb) => cb.addEventListener("change", async () => {
    try {
      await api(`me/venues/${encodeURIComponent(cb.dataset.favVenue)}`, { method: cb.checked ? "PUT" : "DELETE" });
    } catch (e) {
      cb.checked = !cb.checked;
      toast(`Enregistrement impossible : ${e.message}`);
    }
  }));
}

// Attente du calcul : vérification toutes les 20 secondes, puis ouverture du site
function renderWaiting(box, me) {
  box.innerHTML = `
    <h2>Calcul de vos concerts en cours</h2>
    <p>Lecture de votre bibliothèque, puis recherche de vos artistes et de découvertes parmi les concerts à venir. Comptez quelques minutes, parfois davantage si un autre calcul est en cours.</p>
    <p class="cell-sub" id="waiting-state">Cette page se met à jour toute seule.</p>`;
  clearInterval(renderWaiting.timer);
  renderWaiting.timer = setInterval(async () => {
    try {
      const now = await api("me");
      if (now.status === "active") location.reload();
      if (now.status === "error") {
        clearInterval(renderWaiting.timer);
        box.innerHTML = `<h2>Le calcul n'a pas abouti</h2><p class="prefs-warning">${esc(syncText(now.source?.last_sync_status))}</p>
          <p>Corrigez si besoin, puis relancez depuis « Mon compte ».</p><button class="btn" type="button" onclick="location.reload()">Ouvrir le site</button>`;
      }
    } catch { /* nouvel essai au tour suivant */ }
  }, 20000);
}

/* Mon compte ---------------------------------------------------------------------------- */

async function renderAccount() {
  const box = $("#account");
  let me, venues;
  try {
    [me, venues] = await Promise.all([api("me"), api("venues").catch(() => [])]);
  } catch (e) {
    box.innerHTML = `<p class="prefs-warning">Compte illisible : ${esc(e.message)}</p>`;
    return;
  }
  state.me = me;
  const src = me.source;
  const sourceName = src ? `${src.provider === "deezer" ? "Deezer" : "Spotify"}${src.provider_name ? ` (profil « ${esc(src.provider_name)} »)` : ""}` : "aucune";
  box.innerHTML = `
    <section class="account-block">
      <h2 class="month-title">Nom affiché</h2>
      <p>Prénom : ${esc(me.first_name)}. Les autres membres voient ${me.pseudo ? "votre pseudo" : "votre prénom"} : <strong>${esc(me.display_name)}</strong>.</p>
      <form id="pseudo-form" class="account-form inline">
        <label for="pseudo">Pseudo (facultatif)</label>
        <input id="pseudo" type="text" maxlength="30" value="${esc(me.pseudo || "")}" placeholder="${esc(me.first_name)}">
        <button class="btn" type="submit">Enregistrer</button>
      </form>
    </section>
    <section class="account-block">
      <h2 class="month-title">Source musicale</h2>
      <p>${sourceName}</p>
      ${src ? `<p class="cell-sub">Dernière synchronisation : ${esc(fmtDateTime(src.last_sync_at))}${src.last_sync_status ? `, ${esc(syncText(src.last_sync_status))}` : ""}.
        ${me.status === "computing" ? "<br><strong>Calcul en cours.</strong>" : ""}</p>
      <p><button class="btn" type="button" id="sync-now"${me.status === "computing" ? " disabled" : ""}>Synchroniser maintenant</button>
        <button class="btn btn-quiet" type="button" id="change-source">Changer de source</button></p>` : ""}
    </section>
    <section class="account-block">
      <h2 class="month-title">Salles favorites</h2>
      <div class="venue-checks">${venueChecks(venues, new Set(me.favorite_venues || []))}</div>
      <p class="cell-sub">Prises en compte au prochain calcul.</p>
    </section>
    <section class="account-block">
      <h2 class="month-title">Concerts mis de côté</h2>
      <label for="default-visibility">Par défaut, vos ★ sont</label>
      <select id="default-visibility" class="style-filter">
        <option value="private"${me.default_visibility === "private" ? " selected" : ""}>privés</option>
        <option value="members"${me.default_visibility === "members" ? " selected" : ""}>visibles par les membres</option>
      </select>
    </section>
    ${me.role === "admin" ? "" : `<section class="account-block">
      <h2 class="month-title">Supprimer mon compte</h2>
      <p class="cell-sub">Efface votre compte, vos préférences, vos concerts mis de côté et vos résultats. Irréversible.</p>
      <button class="btn btn-quiet" type="button" id="delete-account">Supprimer mon compte</button>
    </section>`}`;

  $("#pseudo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      state.me = await api("me", { method: "PATCH", body: { pseudo: $("#pseudo").value } });
      toast("Nom affiché enregistré");
      renderAccount();
    } catch (err) { toast(`Enregistrement impossible : ${err.message}`); }
  });
  $("#default-visibility").addEventListener("change", async (e) => {
    try {
      await api("me", { method: "PATCH", body: { default_visibility: e.target.value } });
      toast("Réglage enregistré");
    } catch (err) { toast(`Enregistrement impossible : ${err.message}`); }
  });
  bindVenueChecks(box);
  $("#sync-now")?.addEventListener("click", async () => {
    try {
      const r = await api("me/sync", { method: "POST" });
      toast(r.run?.done === false ? "Demande enregistrée ; le calcul aura lieu au prochain traitement" : "Synchronisation lancée : quelques minutes");
      renderAccount();
    } catch (err) { toast(err.message); }
  });
  $("#change-source")?.addEventListener("click", async () => {
    if (!confirm("Changer de source musicale ?\n\nVos résultats actuels seront effacés et recalculés à partir de la nouvelle source. Vos préférences, salles et concerts mis de côté sont conservés.")) return;
    try {
      await api("me/source", { method: "DELETE" });
      location.reload();
    } catch (err) { toast(err.message); }
  });
  $("#delete-account")?.addEventListener("click", async () => {
    if (!confirm("Supprimer définitivement votre compte et toutes vos données ?")) return;
    const typed = prompt("Pour confirmer, tapez SUPPRIMER");
    if (typed !== "SUPPRIMER") { toast("Suppression annulée"); return; }
    try {
      await api("me", { method: "DELETE", body: { confirm: "SUPPRIMER" } });
      document.body.innerHTML = `<main class="onboarding"><h2>Compte supprimé</h2><p>Vos données ont été effacées. Merci d'avoir utilisé Concerts à Paris.</p></main>`;
    } catch (err) { toast(err.message); }
  });
}
