// Ajout d'un concert à un agenda (version 1.16.0) : fichier iCalendar (Apple, Outlook) et lien
// Google Agenda, préparés par la fonction de partage (functions/partage/[[path]].js).
//
// Horaires, fuseau Europe/Paris partout :
// - aucune heure connue : 19h30-23h30, « Horaires indicatifs » ;
// - heure connue : début à cette heure ; fin à 23h30, ou début + 3h si le concert commence avant
//   18h (matinée) ou à 23h et plus tard ;
// - Dice : la page du concert donne l'ouverture des portes (doorTime, souvent égale au début) et
//   la fin, reprise sauf 23h59 (valeur par défaut de la billetterie).
// Aucune donnée n'est inventée : un champ absent n'apparaît pas dans la description.

export const TZ = "Europe/Paris";
const UID_DOMAIN = "concerts-s2k.pages.dev";
const DEFAULT_START = "19:30";
const DEFAULT_END = "23:30";
const LONG_MINUTES = 180;
const GOOGLE_DETAILS_MAX = 1500;  // lien Google : adresse trop longue refusée par certains navigateurs

const pad = (n) => String(n).padStart(2, "0");
// Coupe à n caractères sans couper un emoji (paire de substituts), puis au dernier mot entier
const cut = (s, n) => (Array.from(s).length > n ? Array.from(s).slice(0, n).join("").replace(/\s+\S*$/, "") + "…" : s);
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

// « 2026-11-05 » + « 20:00 » + minutes -> { date, time } (jour suivant si minuit est passé)
export function shift(date, time, minutes) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMinutes(toMinutes(time) + minutes);
  return { date: d.toISOString().slice(0, 10), time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

// « 20:00 » -> « 20h », « 19:30 » -> « 19h30 »
export function hourText(time) {
  const [h, m] = time.split(":");
  return `${Number(h)}h${m === "00" ? "" : m}`;
}

// « 2026-11-05T19:00:00+01:00 » -> { date: "2026-11-05", time: "19:00" } (heure locale de Paris
// telle que publiée par Dice) ; null si illisible
function localPart(iso) {
  const m = String(iso || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? { date: m[1], time: m[2] } : null;
}

const VALID_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Horaires de l'événement et phrase qui les qualifie.
// ev : concert publié (date, time, time_source, links) ; dice : { start, doors, end } lus sur la
// page Dice du concert, ou null.
export function timing(ev, dice = null) {
  const time = VALID_TIME.test(ev.time || "") ? ev.time : null;
  if (!time) {
    return { start: { date: ev.date, time: DEFAULT_START }, end: { date: ev.date, time: DEFAULT_END },
      label: "Horaires indicatifs." };
  }
  const start = { date: ev.date, time };
  // Source de l'horaire : champ du traitement (version 1.16.0) ; données plus anciennes : la seule
  // billetterie du concert, sinon aucune source citée
  const source = ev.time_source || (ev.links?.length === 1 ? ev.links[0].source : null);
  const dStart = localPart(dice?.start);
  const dDoors = localPart(dice?.doors);
  const dEnd = localPart(dice?.end);
  // Les données Dice ne valent que si elles décrivent ce jour et cette heure (l'heure publiée par
  // Dice est son startDate, src/sources/dice.py)
  const diceHere = dStart && dStart.date === ev.date && dStart.time === time;
  // Ouverture des portes : même jour, au plus tard à l'heure de début
  const doors = diceHere && dDoors && dDoors.date === ev.date && dDoors.time <= time ? dDoors.time : null;
  let label;
  let end = null;
  if (doors) {
    label = doors === time
      ? `Ouverture des portes : ${hourText(time)} (source : Dice).`
      : `Ouverture des portes : ${hourText(doors)}, début : ${hourText(time)} (source : Dice).`;
  } else if (source) {
    label = `Début annoncé : ${hourText(time)} (source : ${source}).`;
  } else {
    label = `Début annoncé : ${hourText(time)}.`;
  }
  if (diceHere && dEnd && dEnd.time !== "23:59" && `${dEnd.date}T${dEnd.time}` > `${ev.date}T${time}`) {
    end = dEnd;
    label += ` Fin annoncée : ${hourText(dEnd.time)} (source : Dice).`;
  } else {
    const t = toMinutes(time);
    end = t < toMinutes("18:00") || t >= toMinutes("23:00") ? shift(ev.date, time, LONG_MINUTES) : { date: ev.date, time: DEFAULT_END };
    label += " Heure de fin indicative.";
  }
  return { start, end, label };
}

// c : informations de concertInfo (artist, venue, address, description, tickets, lineup),
// shareUrl : page /partage du concert
export function eventText(ev, c, shareUrl, dice = null, { summaryMax = Infinity } = {}) {
  const when = timing(ev, dice);
  const lineup = [...new Set((dice?.performers || []).map((p) => String(p).trim()).filter(Boolean))];
  const others = (ev.artists || []).filter(Boolean);
  const affiche = lineup.length > 1 ? lineup : others.length > 1 ? others : [];
  const summary = cut(c.description || "", summaryMax);
  const links = (c.tickets || []).map((t) => `Billets (${t.source}) : ${t.url}`);
  const parts = [
    when.label,
    affiche.length ? `À l'affiche : ${affiche.join(", ")}` : "",
    summary,
    [...links, `Fiche du concert : ${shareUrl}`].join("\n"),
  ].filter(Boolean);
  return {
    title: `Concert | ${c.artist} - ${c.venue}`,
    location: [c.venue, c.address].filter(Boolean).join(", "),
    description: parts.join("\n\n"),
    when,
  };
}

// --- iCalendar (RFC 5545) ---------------------------------------------------------------

// Texte : barre oblique inverse, point-virgule, virgule et retour à la ligne échappés (3.3.11)
export function escapeText(s) {
  return String(s ?? "").replace(/\r\n?/g, "\n").replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
}

// Lignes repliées à 75 octets (3.1) : la suite commence par une espace ; un caractère UTF-8 n'est
// jamais coupé en deux
const encoder = new TextEncoder();
export function fold(line) {
  const out = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > limit) {
      out.push(current);
      current = " ";
      bytes = 1;
      limit = 75;
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join("\r\n");
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const local = ({ date, time }) => `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;

// Fuseau de Paris : heure d'été du dernier dimanche de mars au dernier dimanche d'octobre
const VTIMEZONE = [
  "BEGIN:VTIMEZONE", `TZID:${TZ}`,
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
  "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
  "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

// UID stable par concert : un second ajout met à jour l'événement au lieu de le dupliquer
// (selon l'agenda) ; DTSTAMP à l'heure de la demande
export function ics(ev, text, shareUrl, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Concerts a Paris//Concerts 1.16//FR",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    ...VTIMEZONE,
    "BEGIN:VEVENT",
    `UID:${ev.id}@${UID_DOMAIN}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;TZID=${TZ}:${local(text.when.start)}`,
    `DTEND;TZID=${TZ}:${local(text.when.end)}`,
    `SUMMARY:${escapeText(text.title)}`,
    text.location ? `LOCATION:${escapeText(text.location)}` : "",
    `DESCRIPTION:${escapeText(text.description)}`,
    `URL:${shareUrl}`,
    "STATUS:CONFIRMED", "TRANSP:OPAQUE",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean);
  return lines.map(fold).join("\r\n") + "\r\n";
}

// Lien Google Agenda prérempli ; encodeURIComponent : espaces en %20, retours à la ligne en %0A
export function googleUrl(text) {
  const q = {
    action: "TEMPLATE",
    text: text.title,
    dates: `${local(text.when.start)}/${local(text.when.end)}`,
    ctz: TZ,
    details: cut(text.description, GOOGLE_DETAILS_MAX),
    location: text.location,
  };
  return "https://calendar.google.com/calendar/render?" + Object.entries(q).filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

// Nom de fichier sans accent ni espace : « concert-temples-2026-10-17.ics »
export function fileName(ev, artist) {
  const slug = String(artist || "concert").normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "concert";
  return `concert-${slug}-${ev.date}.ics`;
}
