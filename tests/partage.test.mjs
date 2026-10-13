// Fiche /partage : présentation de l'organisateur lue sur Dice (étape 1, version 1.1.0).
// Lancer : node --test tests/partage.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { diceDescription, diceText, onRequestGet } from "../functions/partage/[[path]].js";

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const TEXT = "De ses premières prestations au Dièse Onze aux grandes scènes.";

test("Dice : texte lu dans le bloc JSON-LD de l'événement, objet, liste ou @graph", () => {
  assert.equal(diceText(ld({ "@type": "Organization" }) + ld({ "@type": "MusicEvent", description: TEXT })), TEXT);
  assert.equal(diceText(ld([{ "@type": "WebSite" }, { "@type": "MusicEvent", description: TEXT }])), TEXT);
  assert.equal(diceText(ld({ "@context": "https://schema.org", "@graph": [{ "@type": ["Event", "MusicEvent"], description: TEXT }] })), TEXT);
  assert.equal(diceText("<script type=\"application/ld+json\">{illisible</script>" + ld({ "@type": "Event", description: TEXT })), TEXT);
});

test("Dice : aperçu og:description en secours, rien quand la page n'a aucun texte", () => {
  const html = `<meta property="og:description" content="Concert d&#x27;Eliah &amp; amis..." data-next-head="">`;
  assert.equal(diceText(ld({ "@type": "MusicEvent", description: "  " }) + html), "Concert d'Eliah & amis...");
  assert.equal(diceText("<html><body>Rien</body></html>"), null);
  // Apostrophe dans une valeur entre guillemets, attributs dans l'autre ordre, entité hors limites
  assert.equal(diceText(`<meta content="L'artiste joue" property="og:description">`), "L'artiste joue");
  assert.equal(diceText(ld({ "@type": "MusicEvent", description: "A &amp; B &eacute;t&#99999999;" })), "A & B ét&#99999999;");
  assert.ok(diceText(ld({ "@type": "MusicEvent", description: "mot ".repeat(400) })).length <= 601);
});

// Cache du Worker simulé : ce qui est gardé et pour combien de temps
function fakeCache() {
  const store = new Map();
  globalThis.caches = { default: {
    match: async (req) => (store.has(req.url) ? new Response(store.get(req.url).body) : undefined),
    put: async (req, res) => { store.set(req.url, { body: await res.text(), cc: res.headers.get("cache-control") }); },
  } };
  return store;
}

const SHARD = [{ id: "ab12cd34ef56", title: "Eliah", date: "2026-11-20", venue: "La Maroquinerie", artists: [],
  links: [{ source: "Ticketmaster", url: "https://tm.example/1" }, { source: "Dice", url: "https://dice.fm/event/x1" }] }];

async function callShare(diceReply) {
  return (await callSharePage(diceReply, ".json")).json();
}

async function callSharePage(diceReply, ext = "") {
  const pending = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://dice.fm/")) return diceReply();
    return new Response("{}", { status: 404 });  // Deezer, Wikidata, Spotify : indisponibles dans l'essai
  };
  try {
    const res = await onRequestGet({
      request: new Request(`https://site.test/partage/ab12cd34ef56${ext}`),
      params: { path: [`ab12cd34ef56${ext}`] },
      env: { ASSETS: { fetch: async () => new Response(JSON.stringify(SHARD), { headers: { "content-type": "application/json" } }) } },
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    return res;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const diceKey = "https://partage.cache/dice2/" + encodeURIComponent("https://dice.fm/event/x1");

test("Concert fusionné (Ticketmaster + Dice) : la présentation Dice arrive et reste une semaine en cache", async () => {
  const store = fakeCache();
  const info = await callShare(() => new Response(ld({ "@type": "MusicEvent", description: TEXT })));
  assert.equal(info.organizer, TEXT);
  assert.match(store.get(diceKey).cc, /max-age=604800/);
});

test("Page Dice illisible (erreur ou délai) : rien n'est gardé en cache, nouvel essai à la visite suivante", async () => {
  const store = fakeCache();
  let info = await callShare(() => new Response("indisponible", { status: 503 }));
  assert.equal(info.organizer, null);
  assert.equal(store.has(diceKey), false);
  const page = await callSharePage(() => new Response("indisponible", { status: 503 }));
  assert.equal(page.headers.get("cache-control"), "no-store");
  info = await callShare(() => { throw new Error("délai dépassé"); });
  assert.equal(store.has(diceKey), false);
  info = await callShare(() => new Response(ld({ "@type": "MusicEvent", description: TEXT })));
  assert.equal(info.organizer, TEXT);
});

test("Page Dice lue mais sans texte : résultat vide gardé un jour seulement", async () => {
  const store = fakeCache();
  const info = await callShare(() => new Response("<html></html>"));
  assert.equal(info.organizer, null);
  assert.match(store.get(diceKey).cc, /max-age=86400$/);
  fakeCache();
  const page = await callSharePage(() => new Response("<html></html>"));
  assert.equal(page.headers.get("cache-control"), "public, max-age=3600");  // page lue, sans texte : cache normal
});

test("diceDescription : signale l'échec de lecture sans lever d'erreur", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("réseau"); };
  try {
    assert.deepEqual(await diceDescription("https://dice.fm/event/x"), { text: null, ok: false });
  } finally {
    globalThis.fetch = realFetch;
  }
});
