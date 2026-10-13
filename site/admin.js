"use strict";
// Onglet « Admin » (visible du seul admin ; les routes /api/admin/* vérifient aussi le rôle) :
// invitations, membres (suspendre, réactiver, supprimer, recalculer), places Spotify, traitements.
// Ce que voit l'admin : statut, connexions, activité, nombre de ★, synchronisation ; jamais le
// contenu (artistes, concerts choisis, préférences).

const MEMBER_STATUS = {
  invited: "invité, pas encore venu", onboarding: "accueil en cours", computing: "calcul en cours",
  active: "actif", error: "en erreur", suspended: "suspendu",
};

// Copie en un clic ; « Copié » pendant 2 secondes ; à défaut, texte sélectionné
async function copyText(button, text, field) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "Copié";
    setTimeout(() => { button.textContent = label; }, 2000);
  } catch {
    if (field) { field.focus(); field.select(); }
    toast("Copie impossible : le texte est sélectionné, copiez-le à la main");
  }
}

// Opération Cloudflare non faite (réglage absent ou refus) : à faire à la main dans Zero Trust
const accessNote = (r, task) => (r && r.done === false
  ? `<p class="prefs-warning">À faire à la main dans Cloudflare Zero Trust : ${task} (${esc(r.reason)}).</p>` : "");

// Message à partager : lien et adresse de connexion
function invitationMessage(member, link) {
  return `Bonjour ${member.first_name}, je vous invite sur Concerts à Paris, qui repère les concerts de vos artistes à Paris. ` +
    `Ouvrez ${link} et connectez-vous avec ${member.email} : un code de connexion vous sera envoyé par e-mail.`;
}

// Invitation par lien (adresse inconnue) : la personne saisit elle-même son e-mail
function linkInvitationMessage(first, link) {
  return `Bonjour ${first}, je vous invite sur Concerts à Paris, qui repère les concerts de vos artistes à Paris. ` +
    `Ouvrez ce lien personnel (valable 7 jours) et indiquez votre adresse e-mail : ${link}`;
}

// Invitation par e-mail : message à partager
function showInvitation(out, member, link, intro, notes = "") {
  showMessage(out, intro, invitationMessage(member, link), notes);
}

// Partage comme pour une fiche concert (shareOrCopy, app.js) : menu de partage du téléphone
// (WhatsApp, Messenger, Messages, e-mail…), ou copie du message sur ordinateur. Le lien est dans
// le texte : certaines applications ignorent un lien passé à part. Un seul message affiché à la
// fois ; les boutons sont cherchés dans leur propre bloc.
function showMessage(out, intro, message, notes = "") {
  for (const other of document.querySelectorAll("#invite-result, #link-result, #admin-action-result")) {
    if (other !== out) other.innerHTML = "";
  }
  out.innerHTML = `<p>${intro}</p>
    <p><button class="btn btn-share js-share" type="button">Partager l'invitation</button></p>
    <p class="cell-sub">Choisissez l'application (WhatsApp, Messenger, Messages…) puis le destinataire. Si aucun menu de partage ne s'ouvre, le message est copié : collez-le où vous voulez.</p>
    <textarea class="copy-field js-text" readonly rows="5" aria-label="Message d'invitation">${esc(message)}</textarea>
    <p><button class="btn btn-quiet js-copy" type="button">Copier le message</button></p>${notes}`;
  out.querySelector(".js-copy").addEventListener("click", (ev) => copyText(ev.target, message, out.querySelector(".js-text")));
  out.querySelector(".js-share").addEventListener("click", () =>
    shareOrCopy({ text: message }, "Message copié : collez-le dans WhatsApp, Messenger ou Messages"));
  out.querySelector(".js-share").focus();
}

// Lien d'invitation créé ou renouvelé : message à partager
function showLink(out, r) {
  const first = r.invitation.first_name;
  showMessage(out, `Lien d'invitation pour <strong>${esc(first)}</strong>, valable jusqu'au ${esc(fmtDateTime(r.invitation.expires_at))}. Il ne sert qu'une fois :`,
    linkInvitationMessage(first, r.link));
}

// Liens en attente : nouveau lien (l'ancien ne marche plus) ou suppression
function linksBlock(links) {
  if (!links?.length) return "";
  return `<h3>Liens envoyés, pas encore utilisés</h3><ul class="plain-list">${links.map((l) => `<li>${esc(l.first_name)}
      <span class="cell-sub">${l.expired ? "expiré" : `valable jusqu'au ${esc(fmtDateTime(l.expires_at))}`}</span>
      <button class="link-btn" data-link="renew" data-id="${esc(l.id)}" data-name="${esc(l.first_name)}">Nouveau lien</button>
      <button class="link-btn" data-link="delete" data-id="${esc(l.id)}" data-name="${esc(l.first_name)}">Supprimer</button></li>`).join("")}</ul>`;
}

async function linkAction({ link: action, id, name }) {
  if (action === "renew" && !confirm(`Créer un nouveau lien pour ${name} ? Le lien déjà envoyé ne fonctionnera plus.`)) return;
  try {
    if (action === "delete") {
      if (!confirm(`Supprimer le lien d'invitation de ${name} ? Il ne fonctionnera plus.`)) return;
      await api(`admin/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
      await renderAdmin();
      toast("Lien supprimé");
      return;
    }
    const r = await api(`admin/invitations/${encodeURIComponent(id)}/renew`, { method: "POST" });
    await renderAdmin();
    showLink($("#link-result") || $("#admin"), r);
    toast("Nouveau lien : l'ancien ne fonctionne plus");
  } catch (err) { toast(err.message); }
}

// Salles proposées par les membres (section 13.1) : correction éventuelle, puis décision
function venuesSection(pending) {
  if (!pending) return `<section class="account-block"><h2 class="month-title">Salles à valider</h2><p class="prefs-warning">Propositions illisibles.</p></section>`;
  const cards = pending.map((v) => `<div class="spotify-card" data-venue-card="${esc(v.id)}">
      <p><strong>${esc(v.name)}</strong> <span class="cell-sub">proposée ${v.proposed_by_name ? `par ${esc(v.proposed_by_name)} ` : ""}le ${esc(fmtDateTime(v.proposed_at))}</span></p>
      <div class="account-form">
        <label for="venue-name-${esc(v.id)}">Nom affiché</label>
        <input id="venue-name-${esc(v.id)}" class="js-venue-name" type="text" maxlength="80" value="${esc(v.name)}">
        <label for="venue-aliases-${esc(v.id)}">Autres noms (séparés par des virgules)</label>
        <input id="venue-aliases-${esc(v.id)}" class="js-venue-aliases" type="text" value="${esc(v.aliases.join(", "))}">
        <label for="venue-url-${esc(v.id)}">Page programme</label>
        <input id="venue-url-${esc(v.id)}" class="js-venue-url" type="url" value="${esc(v.agenda_url || "")}">
      </div>
      ${v.overlaps?.length ? `<p class="prefs-warning">Noms proches d'autres salles du catalogue : ${esc(v.overlaps.join(", "))}. Vérifiez que les concerts de ces salles ne lui seront pas rattachés par erreur.</p>` : ""}
      <p class="cell-sub">Vérifiez que la salle est dans la zone couverte et que ses autres noms correspondent à ceux des billetteries.</p>
      <p><button class="btn" type="button" data-venue-review="approve" data-id="${esc(v.id)}">Approuver</button>
        <button class="btn btn-quiet" type="button" data-venue-review="reject" data-id="${esc(v.id)}">Refuser</button></p>
    </div>`).join("");
  return `<section class="account-block">
      <h2 class="month-title">Salles à valider (${pending.length})</h2>
      ${pending.length ? cards : `<p class="cell-sub">Aucune proposition en attente.</p>`}
      <p class="cell-sub">Une salle approuvée est aussitôt proposée comme favorite ; ses concerts sont rattachés au catalogue au prochain traitement.</p>
    </section>`;
}

async function reviewVenue(button) {
  const id = button.dataset.id;
  const card = button.closest("[data-venue-card]");
  try {
    if (button.dataset.venueReview === "approve") {
      // Corrections saisies, puis validation
      await api(`admin/venues/${encodeURIComponent(id)}`, { method: "PATCH", body: {
        name: card.querySelector(".js-venue-name").value,
        aliases: card.querySelector(".js-venue-aliases").value,
        agenda_url: card.querySelector(".js-venue-url").value,
      } });
      await api(`admin/venues/${encodeURIComponent(id)}/approve`, { method: "POST" });
      toast("Salle ajoutée au catalogue");
    } else {
      const note = prompt("Refuser cette salle ? Motif visible par le membre qui l'a proposée (facultatif) :", "");
      if (note === null) return;
      await api(`admin/venues/${encodeURIComponent(id)}/reject`, { method: "POST", body: { note } });
      toast("Proposition refusée");
    }
    await renderAdmin();
  } catch (err) { toast(err.message); }
}

const SPOTIFY_SOURCE_STATUS = {
  pending_allowlist: "demande à traiter", ready_to_connect: "accès ouvert, connexion attendue",
  connected: "relié", revoked: "accès expiré ou retiré", error: "en erreur",
};

// Carte d'un compte Spotify : nom et e-mail à copier, lien direct vers User Management
function spotifyCard(kind, item, dashboard) {
  const key = `${kind}-${item.user_id || item.id}`;
  const field = (label, name, value) => `<label for="${key}-${name}">${label}</label>
    <span class="copy-row"><input id="${key}-${name}" class="copy-field" type="text" readonly value="${esc(value || "")}">
    <button class="btn btn-quiet" type="button" data-copy="${key}-${name}">Copier</button></span>`;
  const head = kind === "request"
    ? `<p><strong>${esc(item.display_name)}</strong> <span class="cell-sub">demande du ${esc(fmtDateTime(item.spotify_requested_at))}</span></p>
       ${item.spotify_refused_at ? `<p class="prefs-warning">Spotify refuse encore ce compte : vérifier l'e-mail (refus du ${esc(fmtDateTime(item.spotify_refused_at))}).</p>` : ""}`
    : `<p><strong>${esc(item.member_name || "membre")}</strong> <span class="cell-sub">${item.reason === "deleted" ? "compte supprimé" : "source changée"} le ${esc(fmtDateTime(item.created_at))}</span></p>`;
  const name = kind === "request" ? item.spotify_account_name : item.account_name;
  const email = kind === "request" ? item.spotify_account_email : item.account_email;
  return `<div class="spotify-card">
    ${head}
    <div class="account-form inline">${field("Nom", "name", name)}${field("E-mail", "email", email)}</div>
    <p class="cell-sub">${kind === "request"
      ? "Dans Spotify : remplissez Full Name avec le nom, puis Email avec l'e-mail, puis Add user."
      : "Dans Spotify : retirez ce compte de la liste des utilisateurs."}</p>
    <p><a class="btn btn-quiet" href="${esc(dashboard)}" target="_blank" rel="noopener">Ouvrir Spotify</a>
      ${kind === "request"
        ? `<button class="btn" type="button" data-spotify="allowlisted" data-id="${esc(item.user_id)}">Fait</button>`
        : `<button class="btn" type="button" data-spotify="removed" data-id="${esc(item.id)}">Retiré</button>`}</p>
  </div>`;
}

function spotifySection(sp) {
  if (!sp) return `<section class="account-block"><h2 class="month-title">Spotify</h2><p class="prefs-warning">Places Spotify illisibles.</p></section>`;
  const members = sp.members.map((m) => `<li>${esc(m.display_name)} : ${esc(SPOTIFY_SOURCE_STATUS[m.status] || m.status)}${m.last_sync_status === "not_allowlisted" ? ", refusé par Spotify au dernier calcul : vérifiez que ce compte figure toujours dans User Management" : m.last_sync_status && m.last_sync_status !== "ok" ? `, dernier calcul : ${esc(m.last_sync_status)}` : ""}
    <span class="cell-sub">${esc(m.spotify_account_email || "")}</span></li>`).join("");
  return `<section class="account-block">
      <h2 class="month-title">Spotify</h2>
      <p><strong>${sp.used} / ${sp.max} places utilisées</strong></p>
      ${sp.used > sp.max ? `<p class="prefs-warning">Plus de comptes que de places : faites d'abord les retraits, puis les ajouts.</p>` : ""}
      <h3>Demandes à traiter (${sp.requests.length})</h3>
      ${sp.requests.length ? sp.requests.map((r) => spotifyCard("request", r, sp.dashboard_url)).join("") : `<p class="cell-sub">Aucune.</p>`}
      ${sp.removals.length ? `<h3>Retraits à faire (${sp.removals.length})</h3>${sp.removals.map((r) => spotifyCard("removal", r, sp.dashboard_url)).join("")}` : ""}
      ${members ? `<h3>Membres Spotify</h3><ul class="plain-list">${members}</ul>` : ""}
    </section>`;
}

async function renderAdmin() {
  const box = $("#admin");
  box.innerHTML = `<p class="cell-sub">Chargement…</p>`;
  let list, runs, spotify, pendingVenues, links;
  try {
    [list, runs, spotify, pendingVenues, links] = await Promise.all([api("admin/members"), api("admin/runs"),
      api("admin/spotify").catch(() => null), api("admin/venues?status=pending").catch(() => null),
      api("admin/invitations").catch(() => null)]);
  } catch (e) {
    box.innerHTML = `<p class="prefs-warning">Espace admin illisible : ${esc(e.message)}</p>`;
    return;
  }
  const rows = list.map((m) => `<tr>
      <td><span class="cell-name">${esc(m.display_name)}</span><span class="cell-sub">${esc(m.email)}${m.role === "admin" ? " · admin" : ""}</span></td>
      <td>${esc(MEMBER_STATUS[m.status] || m.status)}${m.error_message ? `<span class="cell-sub">${esc(m.error_message)}</span>` : ""}${m.invited_via === "link" ? `<span class="cell-sub">inscrit par lien le ${esc(fmtDateTime(m.invited_at))} : vérifiez que l'adresse est bien la sienne</span>` : ""}${m.access_pending ? `<span class="cell-sub"><strong>Accès Cloudflare non ouvert</strong></span>` : ""}</td>
      <td>${m.provider ? esc(m.provider === "deezer" ? "Deezer" : `Spotify${m.source_status !== "connected" ? ` (${SPOTIFY_SOURCE_STATUS[m.source_status] || m.source_status})` : ""}`) : "aucune"}<span class="cell-sub">${m.last_sync_at ? esc(fmtDateTime(m.last_sync_at)) : ""}${m.last_sync_status ? ` · ${esc(m.last_sync_status)}` : ""}</span></td>
      <td class="hide-mobile">${m.last_seen_at ? esc(fmtDateTime(m.last_seen_at)) : "jamais"}<span class="cell-sub">${m.connections_30d} connexion${m.connections_30d > 1 ? "s" : ""}, ${m.api_calls_30d} requêtes, ${m.changes_30d} modifications sur 30 jours</span></td>
      <td class="num">${m.stars}</td>
      <td>${m.role === "admin" ? "" : `
        ${m.access_pending ? `<button class="link-btn" data-admin="access" data-id="${esc(m.id)}">Ouvrir l'accès</button>` : ""}
        ${["invited", "onboarding"].includes(m.status) ? `<button class="link-btn" data-admin="invite" data-first="${esc(m.first_name)}" data-email="${esc(m.email)}">Renvoyer l'invitation</button>` : ""}
        ${m.provider ? `<button class="link-btn" data-admin="recompute" data-id="${esc(m.id)}">Recalculer</button>` : ""}
        ${m.status === "suspended"
          ? `<button class="link-btn" data-admin="reactivate" data-id="${esc(m.id)}">Réactiver</button>`
          : `<button class="link-btn" data-admin="suspend" data-id="${esc(m.id)}" data-name="${esc(m.display_name)}">Suspendre</button>`}
        <button class="link-btn" data-admin="delete" data-id="${esc(m.id)}" data-name="${esc(m.display_name)}">Supprimer</button>`}</td>
    </tr>`).join("");

  const runRows = runs.map((r) => {
    const errors = (r.members || []).filter((m) => m.status === "error");
    const ok = (r.members || []).filter((m) => m.status === "ok").length;
    return `<tr><td class="cell-date">${esc(fmtDateTime(r.started_at))}</td>
      <td>${r.kind === "member" ? "calcul de membre" : r.sources ? "collecte des concerts" : "calcul des membres"}</td>
      <td>${esc(r.status || "")}${r.members?.length ? `<span class="cell-sub">${ok} membre(s) calculé(s)${errors.length ? `, erreurs : ${errors.map((e) => `${esc(e.user_id)} (${esc(e.error_code)})`).join(", ")}` : ""}</span>` : ""}</td></tr>`;
  }).join("");

  box.innerHTML = `
    <section class="account-block">
      <h2 class="month-title">Inviter</h2>
      <p class="cell-sub">Saisissez le prénom : vous obtenez un lien personnel à partager (WhatsApp, Messenger, SMS…). La personne y indique elle-même son adresse e-mail.</p>
      <form id="link-form" class="account-form inline">
        <label for="link-name">Prénom</label><input id="link-name" type="text" required maxlength="40" autocomplete="off">
        <button class="btn" type="submit">Créer le lien d'invitation</button>
      </form>
      <div id="link-result" aria-live="polite"></div>
      ${linksBlock(links)}
      <details class="invite-email">
        <summary>Vous connaissez déjà son adresse e-mail ?</summary>
        <form id="invite-form" class="account-form inline">
          <label for="invite-email">E-mail</label><input id="invite-email" type="email" required autocomplete="off">
          <label for="invite-name">Prénom</label><input id="invite-name" type="text" required maxlength="40" autocomplete="off">
          <button class="btn" type="submit">Inviter et préparer le message</button>
        </form>
        <div id="invite-result" aria-live="polite"></div>
      </details>
    </section>
    <section class="account-block">
      <h2 class="month-title">Membres (${list.length})</h2>
      <div class="table-wrap"><table><thead><tr><th>Membre</th><th>Statut</th><th>Source</th><th class="hide-mobile">Dernière visite</th><th class="num">★</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div id="admin-action-result" aria-live="polite"></div>
    </section>
    ${spotifySection(spotify)}
    ${venuesSection(pendingVenues)}
    <section class="account-block">
      <h2 class="month-title">Traitements</h2>
      <p><button class="btn btn-quiet" type="button" id="run-weekly">Relancer le traitement complet</button></p>
      ${runs.length ? `<div class="table-wrap"><table><thead><tr><th>Début</th><th>Type</th><th>Résultat</th></tr></thead><tbody>${runRows}</tbody></table></div>` : `<p class="cell-sub">Aucun traitement enregistré.</p>`}
    </section>`;

  $("#link-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = e.target.querySelector("button[type=submit]");
    submit.disabled = true;
    let r;
    try {
      r = await api("admin/invitations", { method: "POST", body: { first_name: $("#link-name").value } });
    } catch (err) {
      submit.disabled = false;
      $("#link-result").innerHTML = `<p class="prefs-warning">${esc(err.message)}</p>`;
      return;
    }
    await renderAdmin();
    showLink($("#link-result") || $("#admin"), r);
  });
  box.querySelectorAll("[data-link]").forEach((b) => b.addEventListener("click", () => linkAction(b.dataset)));
  $("#invite-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = e.target.querySelector("button[type=submit]");
    submit.disabled = true;  // pas de double envoi
    let r;
    try {
      r = await api("admin/members", { method: "POST", body: { email: $("#invite-email").value, first_name: $("#invite-name").value } });
    } catch (err) {
      submit.disabled = false;
      $("#invite-result").innerHTML = `<p class="prefs-warning">${esc(err.message)}</p>`;
      return;
    }
    // Invitation créée : tableau rechargé, puis message à transmettre (affiché même si le
    // rechargement échoue)
    await renderAdmin();
    const details = $("details.invite-email");
    if (details) details.open = true;
    const out = $("#invite-result") || $("#admin");
    showInvitation(out, r.member, r.link, `Invitation créée pour <strong>${esc(r.member.first_name)}</strong>. Transmettez-lui le lien :`,
      accessNote(r.access, "ajouter l'adresse à la liste des membres"));
  });
  $("#run-weekly").addEventListener("click", async () => {
    if (!confirm("Relancer le traitement complet (c. 20 minutes) ?")) return;
    try {
      const r = await api("admin/runs", { method: "POST" });
      toast(r.run?.done === false ? `Lancement impossible : ${r.run.reason}` : "Traitement lancé");
    } catch (err) { toast(err.message); }
  });
  box.querySelectorAll("[data-admin]").forEach((b) => b.addEventListener("click", () => adminAction(b.dataset)));
  box.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
    const field = document.getElementById(b.dataset.copy);
    copyText(b, field.value, field);
  }));
  box.querySelectorAll("[data-venue-review]").forEach((b) => b.addEventListener("click", () => reviewVenue(b)));
  box.querySelectorAll("[data-spotify]").forEach((b) => b.addEventListener("click", async () => {
    const done = b.dataset.spotify === "allowlisted";
    if (!done && !confirm("Confirmez-vous avoir retiré ce compte dans le tableau de bord Spotify ?\n\nLe nom et l'e-mail seront effacés et la place libérée.")) return;
    try {
      await api(done ? `admin/spotify/${b.dataset.id}/allowlisted` : `admin/spotify/removals/${b.dataset.id}/removed`, { method: "POST" });
      await renderAdmin();
      toast(done ? "Accès ouvert : le membre voit « Connecter Spotify »" : "Place Spotify libérée");
    } catch (err) { toast(err.message); }
  }));
}

async function adminAction({ admin: action, id, name, first, email }) {
  // Invitation à renvoyer (membre pas encore arrivé) : message seulement, rien n'est modifié
  if (action === "invite") {
    const out = $("#admin-action-result");
    showInvitation(out, { first_name: first, email }, new URL("/", location.href).href,
      `Invitation de <strong>${esc(first)}</strong> (${esc(email)}) :`);
    out.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const questions = {
    suspend: `Suspendre ${name} ?\n\nSon accès est coupé aussitôt ; ses données sont gardées et ses ★ partagés disparaissent.`,
    delete: `Supprimer ${name} ?\n\nToutes ses données sont effacées. Irréversible.`,
  };
  if (questions[action] && !confirm(questions[action])) return;
  const [method, path] = {
    suspend: ["POST", `admin/members/${id}/suspend`], reactivate: ["POST", `admin/members/${id}/reactivate`],
    delete: ["DELETE", `admin/members/${id}`], recompute: ["POST", `admin/members/${id}/recompute`],
    access: ["POST", `admin/members/${id}/access`],
  }[action];
  try {
    const r = await api(path, { method });
    await renderAdmin();
    const notes = accessNote(r.access, "mettre à jour la liste des membres") + accessNote(r.sessions, "couper les sessions du membre")
      + (r.run?.done === false ? `<p class="prefs-warning">Calcul enregistré, lancé au prochain traitement (${esc(r.run.reason)}).</p>` : "");
    $("#admin-action-result").innerHTML = notes;
    toast({ suspend: "Membre suspendu", reactivate: "Membre réactivé", delete: "Membre supprimé", recompute: "Calcul demandé",
      access: r.access?.done === false ? "Accès toujours non ouvert" : "Accès ouvert" }[action]);
  } catch (err) { toast(err.message); }
}
