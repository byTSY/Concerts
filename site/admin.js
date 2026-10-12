"use strict";
// Onglet « Admin » (visible du seul admin ; les routes /api/admin/* vérifient aussi le rôle) :
// invitations, membres (suspendre, réactiver, supprimer, recalculer), traitements.
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

function invitationText(member, link) {
  return `Bonjour ${member.first_name},\n\nJe vous invite sur Concerts à Paris, qui repère les concerts de vos artistes à Paris à partir de votre bibliothèque Deezer.\n\n` +
    `Ouvrez ${link} et connectez-vous avec cette adresse : ${member.email}. Un code de connexion vous sera envoyé par e-mail.\n\n` +
    `Il vous faudra le lien de votre profil Deezer, qui doit être public.`;
}

async function renderAdmin() {
  const box = $("#admin");
  box.innerHTML = `<p class="cell-sub">Chargement…</p>`;
  let list, runs;
  try {
    [list, runs] = await Promise.all([api("admin/members"), api("admin/runs")]);
  } catch (e) {
    box.innerHTML = `<p class="prefs-warning">Espace admin illisible : ${esc(e.message)}</p>`;
    return;
  }
  const rows = list.map((m) => `<tr>
      <td><span class="cell-name">${esc(m.display_name)}</span><span class="cell-sub">${esc(m.email)}${m.role === "admin" ? " · admin" : ""}</span></td>
      <td>${esc(MEMBER_STATUS[m.status] || m.status)}${m.error_message ? `<span class="cell-sub">${esc(m.error_message)}</span>` : ""}</td>
      <td>${m.provider ? esc(m.provider === "deezer" ? "Deezer" : "Spotify") : "aucune"}<span class="cell-sub">${m.last_sync_at ? esc(fmtDateTime(m.last_sync_at)) : ""}${m.last_sync_status ? ` · ${esc(m.last_sync_status)}` : ""}</span></td>
      <td class="hide-mobile">${m.last_seen_at ? esc(fmtDateTime(m.last_seen_at)) : "jamais"}<span class="cell-sub">${m.connections_30d} connexion${m.connections_30d > 1 ? "s" : ""}, ${m.api_calls_30d} requêtes, ${m.changes_30d} modifications sur 30 jours</span></td>
      <td class="num">${m.stars}</td>
      <td>${m.role === "admin" ? "" : `
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
      <td>${r.kind === "weekly" ? "complet" : "membre"}</td>
      <td>${esc(r.status || "")}${r.members?.length ? `<span class="cell-sub">${ok} membre(s) calculé(s)${errors.length ? `, erreurs : ${errors.map((e) => `${esc(e.user_id)} (${esc(e.error_code)})`).join(", ")}` : ""}</span>` : ""}</td></tr>`;
  }).join("");

  box.innerHTML = `
    <section class="account-block">
      <h2 class="month-title">Inviter</h2>
      <form id="invite-form" class="account-form inline">
        <label for="invite-email">E-mail</label><input id="invite-email" type="email" required autocomplete="off">
        <label for="invite-name">Prénom</label><input id="invite-name" type="text" required maxlength="40" autocomplete="off">
        <button class="btn" type="submit">Inviter</button>
      </form>
      <div id="invite-result"></div>
    </section>
    <section class="account-block">
      <h2 class="month-title">Membres (${list.length})</h2>
      <div class="table-wrap"><table><thead><tr><th>Membre</th><th>Statut</th><th>Source</th><th class="hide-mobile">Dernière visite</th><th class="num">★</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div id="admin-action-result"></div>
    </section>
    <section class="account-block">
      <h2 class="month-title">Traitements</h2>
      <p><button class="btn btn-quiet" type="button" id="run-weekly">Relancer le traitement complet</button></p>
      ${runs.length ? `<div class="table-wrap"><table><thead><tr><th>Début</th><th>Type</th><th>Résultat</th></tr></thead><tbody>${runRows}</tbody></table></div>` : `<p class="cell-sub">Aucun traitement enregistré.</p>`}
    </section>`;

  $("#invite-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("#invite-result");
    try {
      const r = await api("admin/members", { method: "POST", body: { email: $("#invite-email").value, first_name: $("#invite-name").value } });
      const text = invitationText(r.member, r.link);
      out.innerHTML = `<p>Invitation créée pour <strong>${esc(r.member.first_name)}</strong>. Message à transmettre (WhatsApp, e-mail) :</p>
        <textarea id="invite-text" class="copy-field" readonly rows="7">${esc(text)}</textarea>
        <p><button class="btn" type="button" id="copy-invite">Copier</button></p>${accessNote(r.access, "ajouter l'adresse à la liste des membres")}`;
      $("#copy-invite").addEventListener("click", (ev) => copyText(ev.target, text, $("#invite-text")));
      $("#invite-form").reset();
      renderAdminTable();
    } catch (err) {
      out.innerHTML = `<p class="prefs-warning">${esc(err.message)}</p>`;
    }
  });
  $("#run-weekly").addEventListener("click", async () => {
    if (!confirm("Relancer le traitement complet (c. 20 minutes) ?")) return;
    try {
      const r = await api("admin/runs", { method: "POST" });
      toast(r.run?.done === false ? `Lancement impossible : ${r.run.reason}` : "Traitement lancé");
    } catch (err) { toast(err.message); }
  });
  box.querySelectorAll("[data-admin]").forEach((b) => b.addEventListener("click", () => adminAction(b.dataset)));
}

// Après une invitation : on recharge la liste sans effacer le message à copier
async function renderAdminTable() {
  const kept = $("#invite-result").innerHTML;
  await renderAdmin();
  $("#invite-result").innerHTML = kept;
  $("#copy-invite")?.addEventListener("click", (ev) => copyText(ev.target, $("#invite-text").value, $("#invite-text")));
}

async function adminAction({ admin: action, id, name }) {
  const questions = {
    suspend: `Suspendre ${name} ?\n\nSon accès est coupé aussitôt ; ses données sont gardées et ses ★ partagés disparaissent.`,
    delete: `Supprimer ${name} ?\n\nToutes ses données sont effacées. Irréversible.`,
  };
  if (questions[action] && !confirm(questions[action])) return;
  const [method, path] = {
    suspend: ["POST", `admin/members/${id}/suspend`], reactivate: ["POST", `admin/members/${id}/reactivate`],
    delete: ["DELETE", `admin/members/${id}`], recompute: ["POST", `admin/members/${id}/recompute`],
  }[action];
  try {
    const r = await api(path, { method });
    await renderAdmin();
    const notes = accessNote(r.access, "mettre à jour la liste des membres") + accessNote(r.sessions, "couper les sessions du membre")
      + (r.run?.done === false ? `<p class="prefs-warning">Calcul enregistré, lancé au prochain traitement (${esc(r.run.reason)}).</p>` : "");
    $("#admin-action-result").innerHTML = notes;
    toast({ suspend: "Membre suspendu", reactivate: "Membre réactivé", delete: "Membre supprimé", recompute: "Calcul demandé" }[action]);
  } catch (err) { toast(err.message); }
}
