// Ajout au calendrier (version 1.16.0) : horaires, description, fichier iCalendar, lien Google
// node --test tests/calendar.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeText, eventText, fileName, fold, googleUrl, ics, shift, timing } from "../functions/_lib/calendar.js";
import { onRequestGet } from "../functions/partage/[[path]].js";

const EV = { id: "ab12cd34ef56", title: "Eliah", date: "2026-11-20", time: "20:00", time_source: "Ticketmaster", venue: "La Maroquinerie",
  artists: ["Eliah"], links: [{ source: "Ticketmaster", url: "https://tm.example/1" }] };

test("Horaires : règle par défaut, matinée, fin de soirée, minuit passé", () => {
  const none = timing({ ...EV, time: null });
  assert.deepEqual([none.start.time, none.end.time, none.label], ["19:30", "23:30", "Horaires indicatifs."]);
  const evening = timing(EV);
  assert.deepEqual([evening.start, evening.end], [{ date: "2026-11-20", time: "20:00" }, { date: "2026-11-20", time: "23:30" }]);
  assert.equal(evening.label, "Début annoncé : 20h (source : Ticketmaster). Heure de fin indicative.");
  assert.deepEqual(timing({ ...EV, time: "16:00" }).end, { date: "2026-11-20", time: "19:00" });
  assert.deepEqual(timing({ ...EV, time: "17:59" }).end, { date: "2026-11-20", time: "20:59" });
  assert.deepEqual(timing({ ...EV, time: "18:00" }).end, { date: "2026-11-20", time: "23:30" });
  assert.deepEqual(timing({ ...EV, time: "22:59" }).end, { date: "2026-11-20", time: "23:30" });
  assert.deepEqual(timing({ ...EV, time: "23:30" }).end, { date: "2026-11-21", time: "02:30" });
  assert.deepEqual(shift("2026-12-31", "23:00", 180), { date: "2027-01-01", time: "02:00" });
  // Heure illisible : traitée comme absente
  assert.equal(timing({ ...EV, time: "25:00" }).label, "Horaires indicatifs.");
});

test("Source de l'horaire : champ time_source, sinon première billetterie ; Dice = ouverture des portes", () => {
  assert.match(timing({ ...EV, time_source: undefined, links: [{ source: "Offi", url: "x" }] }).label, /^Début annoncé : 20h \(source : Offi\)/);
  assert.match(timing({ ...EV, time_source: "Dice" }).label, /^Début annoncé : 20h \(source : Dice\)/);
  // Données publiées avant la version 1.16.0, plusieurs billetteries : aucune source citée
  assert.equal(timing({ ...EV, time_source: undefined, links: [{ source: "Offi" }, { source: "Dice" }] }).label,
    "Début annoncé : 20h. Heure de fin indicative.");
});

test("Ouverture des portes après le début : ignorée ; coupe sans abîmer un emoji", () => {
  const t = timing(EV, { start: "2026-11-20T20:00:00+01:00", doors: "2026-11-20T21:00:00+01:00", end: null });
  assert.equal(t.label, "Début annoncé : 20h (source : Ticketmaster). Heure de fin indicative.");
  const info = { artist: "A", venue: "S", address: null, description: "x".repeat(599) + "😀😀", tickets: [] };
  const url = googleUrl(eventText(EV, info, "https://s/p", null, { summaryMax: 600 }));
  assert.match(decodeURIComponent(url), /x😀…/);
});

test("Page Dice : portes, début et fin repris ; 23h59 ignoré ; autre date ignorée", () => {
  const dice = { start: "2026-11-20T20:00:00+01:00", doors: "2026-11-20T19:00:00+01:00", end: "2026-11-21T02:00:00+01:00" };
  const t = timing(EV, dice);
  assert.equal(t.label, "Ouverture des portes : 19h, début : 20h (source : Dice). Fin annoncée : 2h (source : Dice).");
  assert.deepEqual(t.end, { date: "2026-11-21", time: "02:00" });
  const same = timing(EV, { ...dice, doors: dice.start, end: "2026-11-20T23:59:00+01:00" });
  assert.equal(same.label, "Ouverture des portes : 20h (source : Dice). Heure de fin indicative.");
  assert.equal(same.end.time, "23:30");
  // Données Dice d'un autre soir (concert sur plusieurs dates) : non utilisées
  assert.match(timing(EV, { ...dice, start: "2026-11-21T20:00:00+01:00" }).label, /^Début annoncé/);
});

test("Description : ordre, affiche Dice, aucun champ absent", () => {
  const info = { artist: "Eliah", venue: "La Maroquinerie", address: "23 rue Boyer, Paris", description: "Chanteuse française.",
    tickets: [{ source: "Ticketmaster", url: "https://tm.example/1" }] };
  const dice = { start: "2026-11-20T20:00:00+01:00", doors: "2026-11-20T20:00:00+01:00", end: null, performers: ["Eliah", "Nova", "Eliah"] };
  const t = eventText(EV, info, "https://s/partage/ab12cd34ef56", dice);
  assert.equal(t.title, "Concert | Eliah - La Maroquinerie");
  assert.equal(t.location, "La Maroquinerie, 23 rue Boyer, Paris");
  assert.equal(t.description, ["Ouverture des portes : 20h (source : Dice). Heure de fin indicative.", "À l'affiche : Eliah, Nova",
    "Chanteuse française.", "Billets (Ticketmaster) : https://tm.example/1\nFiche du concert : https://s/partage/ab12cd34ef56"].join("\n\n"));
  const bare = eventText({ ...EV, time: null }, { artist: "X", venue: "Salle", address: null, description: null, tickets: [] }, "https://s/p");
  assert.equal(bare.location, "Salle");
  assert.equal(bare.description, "Horaires indicatifs.\n\nFiche du concert : https://s/p");
});

test("iCalendar : échappement, repli à 75 octets sans couper un caractère, CRLF, UID stable", () => {
  assert.equal(escapeText("a,b;c\\d\ne\r\nf"), "a\\,b\\;c\\\\d\\ne\\nf");
  const long = "DESCRIPTION:" + "é".repeat(100) + "🎸".repeat(20);
  const folded = fold(long);
  for (const line of folded.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), long);  // dépliage : texte d'origine, aucun caractère abîmé
  const info = { artist: "Sigur Rós", venue: "Salle Pleyel", address: "252 rue du Faubourg Saint-Honoré, Paris",
    description: "Groupe islandais, post-rock ; « ambient »", tickets: [] };
  const text = eventText(EV, info, "https://s/partage/ab12cd34ef56");
  const now = new Date("2026-10-29T10:00:00Z");
  const a = ics(EV, text, "https://s/partage/ab12cd34ef56", now);
  const b = ics(EV, text, "https://s/partage/ab12cd34ef56", new Date("2026-11-01T10:00:00Z"));
  assert.ok(a.endsWith("\r\n"));
  assert.doesNotMatch(a.replace(/\r\n/g, ""), /\n/);  // aucune fin de ligne seule
  assert.match(a, /\r\nUID:ab12cd34ef56@concerts-s2k\.pages\.dev\r\n/);
  assert.equal(a.match(/UID:.*/)[0], b.match(/UID:.*/)[0]);
  assert.match(a, /\r\nDTSTAMP:20261029T100000Z\r\n/);
  assert.match(a, /\r\nDTSTART;TZID=Europe\/Paris:20261120T200000\r\n/);
  assert.match(a, /\r\nDTEND;TZID=Europe\/Paris:20261120T233000\r\n/);
  assert.match(a, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Paris/);
  const unfolded = a.replace(/\r\n /g, "");
  assert.match(unfolded, /SUMMARY:Concert \| Sigur Rós - Salle Pleyel/);
  assert.match(unfolded, /LOCATION:Salle Pleyel\\, 252 rue du Faubourg Saint-Honoré\\, Paris/);
  assert.match(unfolded, /post-rock \\; « ambient »/);
});

test("Lien Google : fuseau, dates, retours à la ligne et caractères spéciaux encodés", () => {
  const info = { artist: "Simon & Garfunkel", venue: "L'Olympia", address: "28 bd des Capucines, Paris", description: "Duo #1 ; 100 % folk", tickets: [] };
  const url = googleUrl(eventText({ ...EV, time: "23:30" }, info, "https://s/p?a=x&dz=1"));
  const q = new URL(url).searchParams;
  assert.ok(url.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE&"));
  assert.equal(q.get("ctz"), "Europe/Paris");
  assert.equal(q.get("dates"), "20261120T233000/20261121T023000");
  assert.equal(q.get("text"), "Concert | Simon & Garfunkel - L'Olympia");
  assert.match(q.get("details"), /\n\nDuo #1 ; 100 % folk\n\nFiche du concert : https:\/\/s\/p\?a=x&dz=1$/);
  assert.doesNotMatch(url, /[ \n#]/);  // espaces, retours à la ligne et dièses tous encodés
  assert.equal(fileName(EV, "Sigur Rós / Jónsi"), "concert-sigur-ros-jonsi-2026-11-20.ics");
});

// Route publique /partage/<id>.ics et .google, page Dice simulée
const SHARD = [{ ...EV, links: [...EV.links, { source: "Dice", url: "https://dice.fm/event/x1" }] }];
async function call(path) {
  const store = new Map();
  globalThis.caches = { default: { match: async (r) => (store.has(r.url) ? new Response(store.get(r.url)) : undefined), put: async (r, res) => { store.set(r.url, await res.text()); } } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://dice.fm/")) {
      return new Response(`<script type="application/ld+json">${JSON.stringify({ "@type": "MusicEvent", startDate: "2026-11-20T20:00:00+01:00",
        doorTime: "2026-11-20T20:00:00+01:00", endDate: "2026-11-20T23:59:00+01:00", performer: [{ name: "Eliah" }, { name: "Nova &amp; Co" }], description: "Texte" })}</script>`);
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const pending = [];
    const file = path.split("?")[0];
    const res = await onRequestGet({ request: new Request(`https://site.test/partage/${path}`), params: { path: [file] },
      env: { ASSETS: { fetch: async () => new Response(JSON.stringify(SHARD), { headers: { "content-type": "application/json" } }) } },
      waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return res;
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("GET /partage/<id>.ics : fichier UTF-8, horaires et affiche Dice, artiste du lien conservé", async () => {
  const res = await call("ab12cd34ef56.ics?a=Eliah&dz=123&autre=x");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.match(res.headers.get("content-disposition"), /^inline; filename="concert-eliah-2026-11-20\.ics"$/);
  const body = (await res.text()).replace(/\r\n /g, "");
  assert.match(body, /DESCRIPTION:Ouverture des portes : 20h \(source : Dice\)\. Heure de fin indicative\.\\n\\nÀ l'affiche : Eliah\\, Nova & Co/);
  assert.match(body, /URL:https:\/\/site\.test\/partage\/ab12cd34ef56\?a=Eliah&dz=123\r\n/);
});

test("GET /partage/<id>.google : redirection vers Google Agenda ; concert inconnu : 404", async () => {
  const res = await call("ab12cd34ef56.google");
  assert.equal(res.status, 302);
  const q = new URL(res.headers.get("location")).searchParams;
  assert.equal(q.get("action"), "TEMPLATE");
  assert.equal(q.get("dates"), "20261120T200000/20261120T233000");
  assert.equal((await call("ffffffffffff.ics")).status, 404);
});

test("Adresse : ni virgule vide, ni ville répétée", async () => {
  const { fullAddress } = await import("../functions/partage/[[path]].js");
  assert.equal(fullAddress("2B Rue des Taillandiers, 75011 Paris", "Paris"), "2B Rue des Taillandiers, 75011 Paris");
  assert.equal(fullAddress("58 rue Madame,", "Paris"), "58 rue Madame, Paris");
  assert.equal(fullAddress("1 rue de Paris", "Montreuil"), "1 rue de Paris, Montreuil");
  assert.equal(fullAddress(null, null), null);
});
