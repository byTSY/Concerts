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
  deezer_unavailable: "Deezer n'a pas répondu",
  storage_quota: "stockage plein, l'admin est prévenu",
  internal: "erreur interne, l'admin est prévenu",
  revoked: "l'accès de Concerts à votre compte Spotify a expiré ou a été retiré : reconnectez Spotify",
  not_allowlisted: "Spotify refuse l'accès à votre compte : l'admin est prévenu",
  spotify_unavailable: "Spotify n'a pas répondu",
  quota: "Spotify limite temporairement les appels de l'application (quota commun à tous les membres)",
  token_key: "erreur de configuration, l'admin est prévenu",
  spotify_unconfigured: "erreur de configuration, l'admin est prévenu",
};

// Retour sur le site après l'autorisation chez Spotify (?spotify=…, functions/api/me/spotify/callback.js)
const SPOTIFY_RETURN = {
  ok: "Votre compte Spotify est relié.",
  ok_later: "Votre compte Spotify est relié. Le calcul n'a pas pu être lancé tout de suite ; il aura lieu au prochain traitement, au plus tard lundi matin.",
  denied: "Autorisation annulée chez Spotify : rien n'a été relié.",
  not_allowlisted: "Spotify ne reconnaît pas encore ce compte pour l'application Concerts. L'admin est prévenu et va vérifier l'adresse e-mail ; vous pouvez la corriger ci-dessous.",
  taken: "Ce compte Spotify est déjà rattaché à un autre membre.",
  expired: "L'autorisation a pris plus de 10 minutes : recommencez.",
  bad_state: "Retour Spotify refusé (autorisation commencée depuis une autre session) : recommencez.",
  not_ready: "Votre accès Spotify n'est pas encore ouvert par l'admin.",
  spotify_unconfigured: "Spotify n'est pas encore configuré sur ce site : l'admin est prévenu.",
  bad_code: "Retour Spotify incomplet : recommencez.",
};
let spotifyReturn = (() => {
  const code = new URLSearchParams(location.search).get("spotify");
  if (code) history.replaceState(null, "", location.pathname + location.hash);
  return code;
})();
const spotifyNotice = () => (spotifyReturn && spotifyReturn !== "ok"
  ? `<p class="prefs-warning">${esc(SPOTIFY_RETURN[spotifyReturn] || "La connexion à Spotify n'a pas abouti : recommencez dans quelques minutes.")}</p>` : "");
// Statuts de la source qui permettent de (re)lancer l'autorisation chez Spotify
const SPOTIFY_CONNECTABLE = ["ready_to_connect", "connected", "revoked", "error"];
const connectSpotifyButton = (label) => `<a class="btn" href="api/me/spotify/authorize">${esc(label)}</a>`;
// Code du dernier calcul, avec le nouvel essai automatique prévu (src : source du profil)
const syncText = (code, src) => {
  const text = SYNC_STATUS[code] || (code ? `erreur (${code})` : "");
  if (!code || code === "ok") return text;
  if (src?.retry_at) return `${text} : nouvel essai automatique ${fmtDateTime(src.retry_at)}`;
  return ["quota", "spotify_unavailable", "deezer_unavailable"].includes(code) ? `${text} : nouvel essai au prochain traitement` : text;
};

// Message affiché quand le dernier calcul a échoué (site vide ou résultats anciens), ou null
function syncProblem(me) {
  const src = me?.source;
  if (!src || src.status !== "connected" || !src.last_sync_status || src.last_sync_status === "ok") return null;
  if (me.status !== "error") return null;
  return syncText(src.last_sync_status, src);
}

/* Installer sur l'écran d'accueil (pendant le premier calcul et dans « Mon compte ») ------- */

function installHelp() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua);
  const android = /Android/.test(ua);
  const chrome = /CriOS|Chrome/.test(ua) && !/SamsungBrowser/.test(ua);
  const samsung = /SamsungBrowser/.test(ua);
  const open = (which) => ({ "ios-safari": ios && !chrome, "ios-chrome": ios && chrome, "android-chrome": android && chrome,
    "android-samsung": samsung }[which] ? " open" : "");
  const installed = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
  return `<div class="install-help">
    ${installed ? `<p class="cell-sub">Le site est déjà installé sur cet appareil.</p>` : `<p class="cell-sub">Une icône sur l'écran d'accueil ouvre le site comme une application. À faire depuis cette page, sur votre téléphone.</p>`}
    <details${open("ios-safari")}><summary>iPhone, avec Safari</summary><ol>
      <li>Touchez le bouton Partager (carré avec une flèche vers le haut, en bas de l'écran).</li>
      <li>Faites défiler, puis touchez « Sur l'écran d'accueil ».</li>
      <li>Touchez « Ajouter ».</li></ol></details>
    <details${open("ios-chrome")}><summary>iPhone, avec Chrome</summary><ol>
      <li>Touchez le bouton Partager, à droite de la barre d'adresse.</li>
      <li>Touchez « Ajouter à l'écran d'accueil », puis « Ajouter ».</li></ol></details>
    <details${open("android-chrome")}><summary>Android, avec Chrome</summary><ol>
      <li>Touchez le menu ⋮ en haut à droite.</li>
      <li>Touchez « Ajouter à l'écran d'accueil » (ou « Installer l'application »).</li>
      <li>Touchez « Ajouter ».</li></ol></details>
    <details${open("android-samsung")}><summary>Android, avec Samsung Internet</summary><ol>
      <li>Touchez le menu ☰ en bas à droite.</li>
      <li>Touchez « Ajouter la page à », puis « Écran d'accueil ».</li></ol></details>
  </div>`;
}

/* « J'ai un problème » ---------------------------------------------------------------------- */

const problemButton = (label = "J'ai un problème") => `<button class="btn btn-quiet" type="button" data-problem>${esc(label)}</button>`;

// Contexte joint au message : rien de personnel au-delà de ce que l'admin voit déjà
function problemContext() {
  const me = state.me || {};
  const src = me.source || {};
  const onboarding = !$("#onboarding").hidden;
  return {
    ecran: onboarding ? "accueil (arrivée)" : (state.view || ""),
    source: src.provider || "aucune",
    etat_source: src.status || "",
    dernier_calcul: src.last_sync_at || "",
    resultat_calcul: src.last_sync_status || "",
    artistes: Array.isArray(state.artists) ? state.artists.length : "",
    concerts_charges: Array.isArray(state.events) ? state.events.length : "",
    chargement: state.loadFailed ? `échec (${state.apiError || ""})` : "ok",
    version: $("#app-version")?.textContent || "",
    installe: Boolean(window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone),
    ecran_largeur: window.innerWidth,
    navigateur: navigator.userAgent.slice(0, 180),
  };
}

function openProblem() {
  const dialog = $("#problem");
  $("#problem-result").textContent = "";
  $("#problem-send").disabled = false;
  if (!dialog.open) dialog.showModal();
  $("#problem-text").focus();
}

function bindProblem() {
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-problem]")) { e.preventDefault(); openProblem(); }
  });
  $("#problem-cancel").addEventListener("click", () => $("#problem").close());
  $("#problem-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const send = $("#problem-send");
    send.disabled = true;
    $("#problem-result").textContent = "Envoi…";
    try {
      await api("me/problem", { method: "POST", body: { message: $("#problem-text").value, context: problemContext() } });
      $("#problem-text").value = "";
      $("#problem").close();
      toast("Message envoyé à l'admin, qui vous répondra par e-mail");
    } catch (err) {
      send.disabled = false;
      $("#problem-result").textContent = `Envoi impossible : ${err.message}`;
    }
  });
}
document.addEventListener("DOMContentLoaded", bindProblem);  // après app.js ($, api, toast)

/* Arrivée ----------------------------------------------------------------------------- */

// Écran plein à la place du site : choix de la source, puis attente du premier calcul
function showOnboarding(me) {
  document.body.classList.add("onboarding-mode");
  const box = $("#onboarding");
  box.hidden = false;
  if (me.status === "computing") {
    return renderWaiting(box, me, spotifyReturn === "ok_later" ? SPOTIFY_RETURN.ok_later : "");
  }
  if (me.source?.provider === "spotify") return renderSpotifyStep(box, me);
  const spotifyOpen = me.spotify?.enabled && !me.spotify?.full;
  const spotifyNote = !me.spotify?.enabled ? "bientôt disponible" : me.spotify.full ? "toutes les places sont prises" : "";
  box.innerHTML = `
    ${spotifyNotice()}
    <h2>Bienvenue, ${esc(me.display_name)}</h2>
    <p>Concerts à Paris repère les concerts de vos artistes à partir de votre bibliothèque musicale. Dernière étape : indiquez où elle se trouve.</p>
    <div class="source-choice">
      <label class="source-option"><input type="radio" name="source" value="deezer" checked> <strong>Deezer</strong></label>
      <label class="source-option${spotifyOpen ? "" : " disabled"}"><input type="radio" name="source" value="spotify"${spotifyOpen ? "" : " disabled"}> <strong>Spotify</strong>${spotifyNote ? ` <span class="cell-sub">${esc(spotifyNote)}</span>` : ""}</label>
    </div>
    <form id="deezer-form" class="account-form">
      <label for="deezer-profile">Lien de votre profil Deezer, ou son n°</label>
      <input id="deezer-profile" type="text" inputmode="url" autocomplete="off" placeholder="https://www.deezer.com/fr/profile/123456789" required>
      <p class="cell-sub">Sur deezer.com, ouvrez votre page de profil : son adresse contient votre n°. Dans l'application : votre profil, Partager, Copier le lien. Votre profil doit être public (paramètres de confidentialité de Deezer). Aucun mot de passe n'est demandé.</p>
      <button class="btn" type="submit">Vérifier</button>
    </form>
    <div id="deezer-preview"></div>
    ${spotifyOpen ? spotifyForm(me.email, false) : ""}
    <p>${problemButton()}</p>`;
  $("#deezer-form").addEventListener("submit", (e) => { e.preventDefault(); checkDeezer(); });
  if (spotifyOpen) {
    box.querySelectorAll("input[name=source]").forEach((r) => r.addEventListener("change", () => {
      const spotify = box.querySelector("input[name=source]:checked").value === "spotify";
      $("#deezer-form").hidden = spotify;
      $("#deezer-preview").hidden = spotify;
      $("#spotify-form").hidden = !spotify;
    }));
    bindSpotifyForm(box);
  }
}

/* Spotify : demande de place, attente de l'admin, connexion ------------------------------ */

// Formulaire de demande (section 11) : e-mail du compte Spotify, prérempli (adresse de connexion
// à l'arrivée) ; le nom transmis à l'admin est le prénom du membre (version 1.13.0)
function spotifyForm(email, visible) {
  return `<form id="spotify-form" class="account-form"${visible ? "" : " hidden"}>
      <label for="spotify-email">E-mail de votre compte Spotify</label>
      <input id="spotify-email" type="email" maxlength="200" autocomplete="off" value="${esc(email || "")}" required>
      <p class="cell-sub">Souvent votre adresse de connexion ; sinon, celle de la page <a href="https://www.spotify.com/account/profile/" target="_blank" rel="noopener">Modifier le profil</a> sur spotify.com.</p>
      <p class="cell-sub">Spotify n'ouvre l'application qu'aux comptes ajoutés un par un. En envoyant, vous acceptez que l'admin ajoute ce compte à l'application Concerts chez Spotify.</p>
      <button class="btn" type="submit">Envoyer la demande</button>
      <div id="spotify-result"></div>
    </form>`;
}

function bindSpotifyForm(box) {
  $("#spotify-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("#spotify-result");
    const email = $("#spotify-email").value.trim();
    try {
      const me = await api("me/source/spotify/request", { method: "POST", body: { account_email: email } });
      spotifyReturn = null;  // message du retour précédent, devenu sans objet
      renderSpotifyStep(box, me);
    } catch (err) {
      out.innerHTML = `<p class="prefs-warning">${esc(err.message)}</p>`;
    }
  });
}

// Demande en attente de l'admin, ou accès ouvert : « Connecter Spotify »
function renderSpotifyStep(box, me) {
  const src = me.source;
  clearInterval(renderSpotifyStep.timer);
  if (SPOTIFY_CONNECTABLE.includes(src.status)) {
    box.innerHTML = `${spotifyNotice()}
      <h2>Connectez votre compte Spotify</h2>
      <p>L'admin a ouvert votre accès. Spotify va vous demander d'autoriser l'application Concerts à lire votre bibliothèque (artistes suivis, titres et albums sauvegardés, playlists, artistes les plus écoutés), puis vous ramènera ici.</p>
      <p class="cell-sub">Connectez-vous chez Spotify avec le compte ${esc(src.spotify_account_email || "")}. Aucun mot de passe n'est saisi sur Concerts ; vous pourrez retirer l'accès à tout moment depuis la page Gérer les applis de votre compte Spotify.</p>
      <p>${connectSpotifyButton("Connecter Spotify")}</p>
      <p><button class="btn btn-quiet" type="button" id="spotify-cancel">Choisir Deezer à la place</button> ${problemButton()}</p>`;
  } else {
    box.innerHTML = `${spotifyNotice()}
      <h2>Autorisation en cours par l'admin</h2>
      <p>Votre demande est envoyée par e-mail à l'admin, qui doit ajouter votre compte Spotify à l'application Concerts. Vous recevrez un e-mail dès que ce sera fait ; cette page affichera alors « Connecter Spotify ».</p>
      ${src.spotify_refused_at ? `<p class="prefs-warning">Spotify a refusé ce compte lors de votre dernière connexion : vérifiez l'adresse e-mail ci-dessous.</p>` : ""}
      <p class="cell-sub">Compte demandé : ${esc(src.spotify_account_name || "")}, ${esc(src.spotify_account_email || "")}.</p>
      <details${src.spotify_refused_at ? " open" : ""}><summary>Corriger l'adresse e-mail</summary>${spotifyForm(src.spotify_account_email, true)}</details>
      <p><button class="btn btn-quiet" type="button" id="spotify-cancel">Choisir Deezer à la place</button> ${problemButton()}</p>`;
    bindSpotifyForm(box);
    // L'admin peut ouvrir l'accès pendant que la page est ouverte : vérification chaque minute
    renderSpotifyStep.timer = setInterval(async () => {
      try {
        const now = await api("me");
        if (now.source?.status !== "pending_allowlist") location.reload();
      } catch { /* nouvel essai au tour suivant */ }
    }, 60000);
  }
  $("#spotify-cancel").addEventListener("click", async () => {
    if (!confirm("Abandonner Spotify et choisir Deezer ?")) return;
    try {
      clearInterval(renderSpotifyStep.timer);
      await api("me/source", { method: "DELETE" });
      location.reload();
    } catch (err) { toast(err.message); }
  });
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
    await renderWaiting($("#onboarding"), me, me.run?.done === false
      ? "Le calcul n'a pas pu être lancé tout de suite ; il aura lieu au prochain traitement, au plus tard lundi matin." : "");
  } catch (e) {
    btn.disabled = false;
    $("#deezer-preview").insertAdjacentHTML("beforeend", `<p class="prefs-warning">${esc(e.message)}</p>`);
  }
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

// Attente du calcul, sur un seul écran depuis la version 1.13.0 : installation et salles
// favorites en option ; vérification toutes les 20 secondes, puis ouverture du site.
// notice : avertissement en tête (calcul différé) ; retour réussi de Spotify : message simple.
async function renderWaiting(box, me, notice = "") {
  const venues = await api("venues").catch(() => []);
  const checks = venueChecks(venues, new Set(me.favorite_venues || []));
  box.innerHTML = `
    ${notice ? `<p class="prefs-warning">${esc(notice)}</p>` : ""}
    ${spotifyReturn === "ok" ? `<p><strong>${esc(SPOTIFY_RETURN.ok)}</strong></p>` : ""}
    <h2>Calcul de vos concerts en cours</h2>
    <p>Comptez quelques minutes. Cette page s'ouvre toute seule sur vos concerts dès qu'ils sont prêts ; vous recevrez aussi un e-mail, vous pouvez donc la fermer.</p>
    <h3>En attendant : installer l'application sur votre téléphone</h3>
    ${installHelp()}
    ${checks ? `<h3>Vos salles favorites (facultatif)</h3>
    <p class="cell-sub">Leurs concerts sont signalés et un peu favorisés dans les découvertes. Modifiable plus tard dans « Mon compte ».</p>
    <div class="venue-checks">${checks}</div>` : ""}
    <p>${problemButton()}</p>`;
  bindVenueChecks(box);
  clearInterval(renderWaiting.timer);
  renderWaiting.timer = setInterval(async () => {
    try {
      const now = await api("me");
      if (now.status === "active") location.reload();
      if (now.status === "error") {
        clearInterval(renderWaiting.timer);
        state.me = now;
        const auto = Boolean(now.source?.retry_at);
        box.innerHTML = `<h2>Le calcul n'a pas encore abouti</h2><p class="prefs-warning">${esc(syncText(now.source?.last_sync_status, now.source))}.</p>
          <p>${auto ? "Rien à faire de votre côté : vous recevrez un e-mail dès que vos concerts seront prêts."
            : "Corrigez si besoin, puis relancez depuis « Mon compte »."}</p>
          <p><button class="btn" type="button" onclick="location.reload()">Ouvrir le site</button> ${problemButton()}</p>`;
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
  const reconnect = src?.provider === "spotify" && src.status === "revoked";
  const spotifyStep = src?.provider === "spotify" && ["pending_allowlist", "ready_to_connect"].includes(src.status);
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
      ${spotifyNotice()}
      <p>${sourceName}</p>
      ${reconnect ? `<p class="prefs-warning">L'accès de Concerts à votre compte Spotify a expiré ou a été retiré : vos concerts ne sont plus mis à jour.</p>
        <p>${connectSpotifyButton("Reconnecter Spotify")}</p>` : ""}
      ${spotifyStep ? `<div id="spotify-step"></div>` : ""}
      ${src ? `<p class="cell-sub">Dernière synchronisation : ${esc(fmtDateTime(src.last_sync_at))}${src.last_sync_status ? `, ${esc(syncText(src.last_sync_status, src))}` : ""}.
        ${me.status === "computing" ? "<br><strong>Calcul en cours.</strong>" : ""}</p>
      <p>${reconnect || spotifyStep ? "" : `<button class="btn" type="button" id="sync-now"${me.status === "computing" ? " disabled" : ""}>Synchroniser maintenant</button>`}
        <button class="btn btn-quiet" type="button" id="change-source">Changer de source</button></p>` : ""}
    </section>
    <section class="account-block">
      <h2 class="month-title">Installer l'application sur votre téléphone</h2>
      ${installHelp()}
    </section>
    <section class="account-block">
      <h2 class="month-title">Un souci ?</h2>
      <p class="cell-sub">Votre message part à l'admin avec l'état de votre compte ; l'admin vous répond par e-mail.</p>
      <p>${problemButton()}</p>
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
        <option value="members"${me.default_visibility !== "private" ? " selected" : ""}>visibles par les membres</option>
        <option value="private"${me.default_visibility === "private" ? " selected" : ""}>masqués (visibles par vous seul)</option>
      </select>
    </section>
    ${me.newsletter === null || me.newsletter === undefined ? "" : `<section class="account-block">
      <h2 class="month-title">Newsletter du lundi</h2>
      <label class="chip"><input type="checkbox" id="newsletter"${me.newsletter ? " checked" : ""}> Recevoir chaque lundi par e-mail les annonces de mes artistes, mes recommandations et mes prochains concerts</label>
      <p class="cell-sub">Envoyée à ${esc(me.email)}.</p>
    </section>`}
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
      state.me = await api("me", { method: "PATCH", body: { default_visibility: e.target.value } });
      toast("Réglage enregistré");
    } catch (err) { toast(`Enregistrement impossible : ${err.message}`); }
  });
  $("#newsletter")?.addEventListener("change", async (e) => {
    try {
      state.me = await api("me", { method: "PATCH", body: { newsletter: e.target.checked } });
      toast(e.target.checked ? "Newsletter du lundi activée" : "Vous ne recevrez plus la newsletter");
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(`Enregistrement impossible : ${err.message}`);
    }
  });
  bindVenueChecks(box);
  if (spotifyStep) renderSpotifyStep($("#spotify-step"), me);
  $("#sync-now")?.addEventListener("click", async () => {
    try {
      const r = await api("me/sync", { method: "POST" });
      toast(r.run?.done === false ? "Demande enregistrée ; le calcul aura lieu au prochain traitement" : "Synchronisation lancée : quelques minutes");
      renderAccount();
    } catch (err) { toast(err.message); }
  });
  $("#change-source")?.addEventListener("click", async () => {
    const spotifyNote = src?.provider === "spotify" ? "\n\nL'accès de Concerts à votre compte Spotify sera supprimé de notre côté ; vous pouvez aussi le retirer depuis la page Gérer les applis de votre compte Spotify." : "";
    if (!confirm(`Changer de source musicale ?\n\nVos résultats actuels seront effacés et recalculés à partir de la nouvelle source. Vos préférences, salles et concerts mis de côté sont conservés.${spotifyNote}`)) return;
    try {
      await api("me/source", { method: "DELETE" });
      location.reload();
    } catch (err) { toast(err.message); }
  });
  $("#delete-account")?.addEventListener("click", async () => {
    const spotifyNote = src?.provider === "spotify" ? "\n\nPensez aussi à retirer l'accès de l'application Concerts depuis la page Gérer les applis de votre compte Spotify." : "";
    if (!confirm(`Supprimer définitivement votre compte et toutes vos données ?${spotifyNote}`)) return;
    const typed = prompt("Pour confirmer, tapez SUPPRIMER");
    if (typed !== "SUPPRIMER") { toast("Suppression annulée"); return; }
    try {
      await api("me", { method: "DELETE", body: { confirm: "SUPPRIMER" } });
      document.body.innerHTML = `<main class="onboarding"><h2>Compte supprimé</h2><p>Vos données ont été effacées. Merci d'avoir utilisé Concerts à Paris.</p></main>`;
    } catch (err) { toast(err.message); }
  });
}
