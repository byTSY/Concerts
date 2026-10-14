"""Contrôle de la lecture d'une page programme, et vérification des salles proposées (version 1.12.0).

check(événements, référence) dit si la lecture semble avoir fonctionné. Elle échoue si :
- moins de MIN_UPCOMING événements à venir, ou moins de MIN_UPCOMING concerts (hors soirées club,
  ateliers… repérés sur les cartes) ;
- plus de 30 % de dates passées (archives lues à la place du programme) ;
- moins de 3 jours différents ;
- titres manquants (plus de 20 %) ou génériques (« Concert », « Jazz » : genre lu à la place du
  nom, plus de 20 %) ;
- lecture par les cartes de la page seulement (les fiches schema.org sont fiables par nature) :
  titres répétés (moins de la moitié de titres différents), ou moins de la moitié des titres qui
  partagent un mot avec l'adresse de leur lien (cartes décalées) ;
- la salle est déjà connue des billetteries (au moins 3 concerts sur la période) et moins de 30 %
  des concerts lus y figurent à la même date sous un titre voisin.

Tâche venue-check (workflow venue-check.yml, lancé par le site à chaque proposition avec page
programme, ou par « Relancer la vérification » dans l'Admin) : chaque salle en attente dont la
vérification est demandée est lue ; réussite, la salle entre au catalogue (ajout automatique,
message à l'admin) ; échec, elle reste en attente avec les raisons, et l'admin est prévenu.

Essai sans rien écrire : python -m src.venue_check <adresse> [nom de la salle]
"""
import json
import sys
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse

from . import members, notify
from .util import log

MIN_UPCOMING = 3
MAX_PAST_SHARE = 0.3
MAX_MISSING_TITLES = 0.2
MIN_DISTINCT_TITLES = 0.5
MAX_GENERIC_TITLES = 0.2
MIN_SLUG_AGREEMENT = 0.5
MIN_REFERENCE = 3
MIN_REFERENCE_AGREEMENT = 0.3
SAMPLE = 5
FULL_RUN_GAP_HOURS = 6   # au plus un traitement complet lancé par un ajout de salle par période


def check(events, reference=None, today=None):
    """{"ok", "reasons", "stats", "sample"} pour des événements lus (date, title, url…).
    reference : [(date ISO, titre)] des concerts de la salle connus par les billetteries."""
    from .sources.venues import GENERIC_TITLES, HORIZON_DAYS, fold, words

    today = today or date.today()
    horizon = today + timedelta(days=HORIZON_DAYS)
    upcoming = [e for e in events if today <= e["date"] <= horizon]
    past = [e for e in events if e["date"] < today]
    titled = [e for e in upcoming if e.get("title")]
    titles = [fold(e["title"]).strip(" .") for e in titled]
    cards = [e for e in titled if e.get("card")]
    card_titles = [fold(e["title"]).strip(" .") for e in cards]
    # Lien comparable : adresse propre dont le dernier dossier contient des mots (« /agenda/alex-cameron »)
    linked = [e for e in cards if e.get("url") and words(urlparse(e["url"]).path.rstrip("/").rsplit("/", 1)[-1])]
    slug_ok = [e for e in linked if words(e["title"]) & words(urlparse(e["url"]).path)]
    concerts = [e for e in upcoming if not e.get("category")]

    reasons = []
    if len(upcoming) < MIN_UPCOMING:
        reasons.append(f"{len(upcoming)} concert(s) à venir trouvé(s), {MIN_UPCOMING} au moins attendus")
    elif len(concerts) < MIN_UPCOMING:
        reasons.append(f"{len(concerts)} concert(s) parmi {len(upcoming)} événements (soirées club, ateliers…), "
                       f"{MIN_UPCOMING} au moins attendus")
    if events and len(past) > len(events) * MAX_PAST_SHARE:
        reasons.append("trop de dates passées (archives lues ?)")
    if upcoming and len({e["date"] for e in upcoming}) < min(3, len(upcoming)):
        reasons.append("dates trop peu variées")
    if upcoming and len(titled) < len(upcoming) * (1 - MAX_MISSING_TITLES):
        reasons.append("titres manquants")
    if card_titles and len(set(card_titles)) < len(card_titles) * MIN_DISTINCT_TITLES:
        reasons.append("titres répétés")
    if titles and sum(t in GENERIC_TITLES for t in titles) > len(titles) * MAX_GENERIC_TITLES:
        reasons.append("titres génériques (genre lu à la place du nom)")
    if len(linked) >= MIN_UPCOMING and len(slug_ok) < len(linked) * MIN_SLUG_AGREEMENT:
        reasons.append(f"titres sans rapport avec leur lien ({len(slug_ok)} sur {len(linked)})")

    agreement = None
    if upcoming and reference:
        first, last = min(e["date"] for e in upcoming).isoformat(), max(e["date"] for e in upcoming).isoformat()
        period = [(d, t) for d, t in reference if first <= d <= last]
        if len(period) >= MIN_REFERENCE:
            by_day = {}
            for d, t in period:
                by_day.setdefault(d, set()).update(words(t))
            hits = sum(1 for e in titled if words(e["title"]) & by_day.get(e["date"].isoformat(), set()))
            agreement = round(hits / min(len(upcoming), len(period)), 2)
            if agreement < MIN_REFERENCE_AGREEMENT:
                reasons.append(f"peu de concerts communs avec les billetteries ({hits} sur {min(len(upcoming), len(period))})")

    sample = [{"date": e["date"].isoformat(), "time": e.get("time"), "title": e.get("title"), "url": e.get("url")}
              for e in sorted(concerts or upcoming, key=lambda e: (e["date"], e.get("time") or ""))[:SAMPLE]]
    stats = {"upcoming": len(upcoming), "concerts": len(concerts), "past": len(past), "agreement": agreement}
    return {"ok": not reasons, "reasons": reasons, "stats": stats, "sample": sample}


def summary(got):
    """Résumé enregistré dans venues.check_summary (affiché dans l'Admin et dans l'e-mail)."""
    return {"method": got.get("method"), "url": got.get("url"), "reasons": got.get("reasons", []),
            "stats": got.get("stats", {}), "sample": got.get("sample", [])}


def examine(venue, collected):
    """Lecture et contrôle d'une salle (ligne de la table venues, alias en JSON)."""
    from .sources import venues as venue_pages

    v = dict(venue, aliases=json.loads(venue.get("aliases") or "[]") if isinstance(venue.get("aliases"), str) else venue.get("aliases") or [])
    if not v.get("agenda_url"):
        return {"ok": False, "method": "aucune", "url": None, "events": [], "reasons": ["pas de page programme"],
                "stats": {"upcoming": 0, "concerts": 0, "past": 0, "agreement": None}, "sample": []}
    reference = venue_pages.reference_for(v, (collected or {}).get("events"))
    try:
        return venue_pages.read_venue(v["agenda_url"], reference)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "method": "aucune", "url": v["agenda_url"], "events": [],
                "reasons": [f"erreur de lecture ({exc.__class__.__name__})"],
                "stats": {"upcoming": 0, "concerts": 0, "past": 0, "agreement": None}, "sample": []}


def run(db, store, collected_key, venue_ids=()):
    """Vérifie les salles en attente dont la vérification est demandée (check_status running),
    plus celles de venue_ids encore en attente. Renvoie le nombre de salles ajoutées."""
    ids = [i for i in venue_ids if i]
    marks = ", ".join("?" for _ in ids)
    rows = db.query(
        "SELECT v.id, v.name, v.aliases, v.agenda_url, v.proposed_by, COALESCE(u.pseudo, u.first_name) AS proposer "
        "FROM venues v LEFT JOIN users u ON u.id = v.proposed_by WHERE v.status = 'pending' AND v.agenda_url IS NOT NULL "
        f"AND (v.check_status = 'running'{f' OR v.id IN ({marks})' if ids else ''}) ORDER BY v.proposed_at", ids)
    if not rows:
        log("Aucune salle à vérifier")
        return 0
    collected = store.get_json(collected_key) or {}
    added = 0
    for v in rows:
        got = examine(v, collected)
        stamp = members.now_iso()
        info = json.dumps(summary(got), ensure_ascii=False)
        payload = {"venue": v["id"], "name": v["name"], "url": v["agenda_url"], "proposer": v.get("proposer"), **summary(got)}
        if got["ok"]:
            changed = db.query(
                "UPDATE venues SET status = 'approved', auto_approved = 1, reviewed_at = ?, review_note = ?, "
                "check_status = 'ok', check_summary = ?, checked_at = ? WHERE id = ? AND status = 'pending' RETURNING id",
                [stamp, "ajoutée automatiquement après vérification de sa page programme", info, stamp, v["id"]])
            if changed:
                added += 1
                notify.queue(db, "venue_added", to_admin=True, payload=payload, dedupe=f"venue_added:{v['id']}:{stamp}")
                log(f"{v['name']} : ajoutée au catalogue ({got['stats']['upcoming']} concerts, {got['method']})")
        else:
            changed = db.query("UPDATE venues SET check_status = 'failed', check_summary = ?, checked_at = ? "
                               "WHERE id = ? AND status = 'pending' RETURNING id", [info, stamp, v["id"]])
            if changed:
                notify.queue(db, "venue_check_failed", to_admin=True, payload=payload,
                             dedupe=f"venue_check_failed:{v['id']}:{stamp}")
                log(f"{v['name']} : lecture refusée ({'; '.join(got['reasons'])}), transmise à l'admin")
    return added


def monday_window(now=None):
    """Lundi de 5 h à 9 h UTC : traitement complet du lundi en cours, rien à lancer."""
    now = now or datetime.now(timezone.utc)
    return now.weekday() == 0 and 5 <= now.hour < 9


def full_run_due(db, now=None):
    """Une salle a été ajoutée au catalogue depuis le début de la dernière collecte, et cette
    collecte date de plus de FULL_RUN_GAP_HOURS heures (hors lundi matin)."""
    now = now or datetime.now(timezone.utc)
    if monday_window(now):
        return False
    # Dernier traitement lancé, réussi ou non (en cours, ou en échec : pas de relance en boucle
    # toutes les 2 heures si la collecte échoue) : FULL_RUN_GAP_HOURS heures au moins depuis
    gap = (now - timedelta(hours=FULL_RUN_GAP_HOURS)).isoformat(timespec="seconds")
    if db.query("SELECT 1 FROM runs WHERE kind = 'weekly' AND started_at > ? LIMIT 1", [gap]):
        return False
    # Salle ajoutée depuis le début de la dernière collecte réussie
    rows = db.query("SELECT started_at FROM runs WHERE kind = 'weekly' AND status = 'ok' AND sources IS NOT NULL "
                    "ORDER BY ended_at DESC LIMIT 1")
    started = rows[0]["started_at"] if rows else ""
    return bool(db.query("SELECT 1 FROM venues WHERE status = 'approved' AND reviewed_at > ? LIMIT 1", [started or ""]))


def main(argv):
    """Essai d'une adresse, sans rien écrire : méthode retenue, raisons, 10 premiers concerts."""
    from .sources import venues as venue_pages

    if not argv:
        print("Usage : python -m src.venue_check <adresse de la page programme> [nom de la salle]")
        return 2
    url = argv[0]
    reference = []
    if len(argv) > 1:
        try:
            from .util import SITE_DATA
            published = json.loads((SITE_DATA / "events.json").read_text(encoding="utf-8"))
            published = published.get("events", published) if isinstance(published, dict) else published
            reference = venue_pages.reference_for({"name": " ".join(argv[1:]), "aliases": []}, published)
        except (OSError, ValueError):
            reference = []
    got = venue_pages.read_venue(url, reference)
    print(f"{'Lecture réussie' if got['ok'] else 'Lecture refusée'} : {got['method']} ({got['url']})")
    st = got["stats"]
    print(f"{st['upcoming']} événements à venir, dont {st['concerts']} concerts ; {st['past']} dates passées"
          + (f" ; concordance avec les billetteries : {round(st['agreement'] * 100)} %" if st.get("agreement") is not None else ""))
    for r in got["reasons"]:
        print(f"  - {r}")
    for e in sorted(got["events"], key=lambda e: e["date"])[:10]:
        print(f"  {e['date']} {e.get('time') or '     '}  {e.get('title') or '?'}"
              + (f"  [{e['category']}]" if e.get("category") else ""))
    return 0 if got["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
