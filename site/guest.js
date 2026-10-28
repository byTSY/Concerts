"use strict";
// Mode invité (version 1.15.0) : page /visite/<jeton>/ (functions/visite/[[path]].js), sans
// connexion. L'univers de l'admin qui a créé le lien (artistes, concerts retenus, préférences
// d'artistes, salles favorites) est lu une fois, en lecture seule (api/guest). Tout ce que fait
// l'invité (★ intéressé ou places prises, retraits, fiches vues, artistes masqués) reste dans
// la mémoire de cette page : rien n'est envoyé au serveur, et un rechargement efface tout.
// Les autres routes (Admin, newsletter, Deezer, Spotify, signalements, propositions de salles)
// répondent « indisponible en mode invité ».

const GUEST = Boolean(window.GUEST_MODE);

const guest = {
  load: null,
  stars: [], removed: [], seen: [], monthSeen: new Map(), prefs: null, favorites: null,
};

function guestBundle() {
  if (!guest.load) {
    guest.load = fetch("api/guest", { cache: "no-store" }).then(async (r) => {
      const data = r.ok ? await r.json().catch(() => null) : null;
      if (!data) throw new ApiError("ce lien d'invité n'est plus valable", r.status || 0, "guest_link");
      guest.prefs = structuredClone(data.prefs || { hidden: [], levels: {} });
      guest.favorites = [...(data.profile?.favorite_venues || [])];
      return data;
    }, () => { guest.load = null; throw new ApiError("réseau indisponible", 0, "network"); });
  }
  return guest.load;
}

const guestNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
const guestRefused = () => new ApiError("indisponible en mode invité", 403, "guest");
const copy = (v) => structuredClone(v);

// Même contrat que les routes /api/me/* (functions/_lib/me.js), en mémoire
async function guestApi(path, { method = "GET", body } = {}) {
  const data = await guestBundle();
  const [route] = path.split("?");
  const parts = route.split("/").map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const [head, sub, arg] = parts;
  const get = method === "GET";

  if (head === "me" && parts.length === 1 && get) return { ...copy(data.profile), favorite_venues: [...guest.favorites] };
  if (head === "venues" && parts.length === 1 && get) return copy(data.venues);
  if (head === "venues" && sub === "proposals" && get) return [];
  if (head === "community" && sub === "stars" && get) return [];
  if (head !== "me") throw guestRefused();

  switch (sub) {
    case "concerts":
      if (get) return copy(data.concerts);
      break;
    case "artists":
      if (get && !arg) return copy(data.artists);
      if (method === "PUT" && arg) {
        const name = body?.name || arg;
        const hidden = new Map(guest.prefs.hidden.map((n) => [normName(n), n]));
        const levels = new Map(Object.entries(guest.prefs.levels).map(([n, l]) => [normName(n), [n, l]]));
        const key = normName(name);
        if (body.hidden !== undefined) body.hidden ? hidden.set(key, hidden.get(key) || name) : hidden.delete(key);
        if (body.level !== undefined) body.level ? levels.set(key, [levels.get(key)?.[0] || name, body.level]) : levels.delete(key);
        guest.prefs = { hidden: [...hidden.values()], levels: Object.fromEntries(levels.values()) };
        return copy(guest.prefs);
      }
      break;
    case "prefs":
      if (get) return copy(guest.prefs);
      break;
    case "stars":
      if (get && !arg) return copy(guest.stars);
      if (method === "PUT" && arg) {
        const current = guest.stars.find((s) => s.concert_id === arg);
        const now = guestNow();
        const next = {
          concert_id: arg,
          label: body?.label ?? current?.label ?? "",
          status: body?.status ?? current?.status ?? "interested",
          visibility: "private",
          created_at: current?.created_at || now,
          updated_at: now,
        };
        guest.stars = current ? guest.stars.map((s) => (s.concert_id === arg ? next : s)) : [...guest.stars, next];
        return copy(guest.stars);
      }
      if (method === "DELETE" && arg) {
        guest.stars = guest.stars.filter((s) => s.concert_id !== arg);
        return copy(guest.stars);
      }
      break;
    case "removed":
      if (get && !arg) return copy(guest.removed);
      if (method === "PUT" && arg) {
        guest.removed = [...guest.removed.filter((r) => r.concert_id !== arg), {
          concert_id: arg, concert_date: body?.date, label: body?.label || "", venue: body?.venue || null,
          title: body?.title || null, urls: (body?.urls || []).filter((u) => /^https?:\/\//i.test(String(u))), removed_at: guestNow(),
        }].sort((a, b) => (a.concert_date < b.concert_date ? -1 : a.concert_date > b.concert_date ? 1 : 0));
        guest.stars = guest.stars.filter((s) => s.concert_id !== arg);
        return { removed: copy(guest.removed), stars: copy(guest.stars) };
      }
      if (method === "DELETE" && arg) {
        guest.removed = guest.removed.filter((r) => r.concert_id !== arg);
        return copy(guest.removed);
      }
      break;
    case "seen":
      if (get) return [...guest.seen];
      if (method === "POST") {
        guest.seen = [...new Set([...guest.seen, ...(body?.ids || []).map(String)])];
        return [...guest.seen];
      }
      break;
    case "month-seen": {
      const list = () => [...guest.monthSeen].map(([id, month]) => ({ id, month }));
      if (get) return list();
      if (method === "POST") {
        for (const it of body?.items || []) guest.monthSeen.set(String(it.id), String(it.month));
        return list();
      }
      if (method === "DELETE") {
        const ids = new Set((body?.ids || []).map(String));
        for (const [id, month] of [...guest.monthSeen]) if (month === body?.month || ids.has(id)) guest.monthSeen.delete(id);
        return list();
      }
      break;
    }
    case "venues":
      if (["PUT", "DELETE"].includes(method) && parts.length === 3) {
        guest.favorites = method === "PUT" ? [...new Set([...guest.favorites, arg])] : guest.favorites.filter((v) => v !== arg);
        return [...guest.favorites];
      }
      break;
    default:
      break;
  }
  throw guestRefused();
}

// Bandeau discret en haut de l'écran, et éléments sans objet pour un invité
function setupGuest(me) {
  document.body.classList.add("guest-mode");
  document.querySelector(".masthead").insertAdjacentHTML("afterbegin",
    `<p class="guest-banner" role="note">Mode démo, vos actions ne sont pas enregistrées.
      <a href="/">Se connecter</a></p>`);
  if (me?.owner_name) document.title = `Concerts à Paris (invité de ${me.owner_name})`;
  for (const sel of ["#tab-admin", "#view-admin", ".app-version [data-problem]", ".app-version [aria-hidden]"]) {
    document.querySelectorAll(sel).forEach((el) => el.remove());
  }
  document.querySelector("#with-members")?.closest("label")?.remove();
}

// Onglet « Mon compte » d'un invité : explication et salles favorites (en mémoire)
async function renderGuestAccount() {
  const box = $("#account");
  let me, venues;
  try {
    [me, venues] = await Promise.all([api("me"), api("venues")]);
  } catch (e) {
    box.innerHTML = `<p class="prefs-warning">${esc(e.message)}</p>`;
    return;
  }
  box.innerHTML = `
    <section class="account-block">
      <h2 class="month-title">Mode invité</h2>
      <p>Vous découvrez l'application avec les artistes et les salles de ${esc(me.owner_name)}. Vous pouvez tout essayer :
        mettre un concert de côté (★ Intéressé, Places prises), en retirer un, parcourir les cercles NEW et ceux des mois, ouvrir le calendrier.</p>
      <p class="cell-sub">Rien n'est enregistré : tout disparaît quand vous rechargez ou fermez la page. Sans compte, pas de newsletter, ni de connexion Deezer ou Spotify.</p>
      <p><a class="btn" href="/">Se connecter</a></p>
    </section>
    <section class="account-block">
      <h2 class="month-title">Salles favorites</h2>
      <div class="venue-checks">${venueChecks(venues, new Set(me.favorite_venues || []))}</div>
      <p class="cell-sub">Pour un membre, elles orientent le calcul de ses concerts ; ici, le choix n'est pas gardé.</p>
    </section>
    <section class="account-block">
      <h2 class="month-title">Installer l'application sur votre téléphone</h2>
      ${installHelp()}
    </section>`;
  bindVenueChecks(box);
}
