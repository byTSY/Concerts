"""Newsletter du lundi (version 1.5.0) : un e-mail par membre, à la fin du traitement du lundi.

Contenu, à partir de la dernière collecte (R2 common/collected.json), des résultats du membre
(R2 users/<id>/overlay.json) et de ses ★ (D1) :
1. concerts de ses artistes annoncés cette semaine (badge « annonce » ou « liste ») ;
2. recommandations des 30 jours suivants (ses artistes et découvertes, 15 au plus) ;
3. ses prochains concerts (« Places prises »).

Envoi par SMTP (compte Gmail dédié avec mot de passe d'application, ou relais Brevo) :
SMTP_HOST, SMTP_PORT (587 STARTTLS, 465 SSL), SMTP_USER, SMTP_PASSWORD, NEWSLETTER_FROM
(facultatif, SMTP_USER par défaut), SITE_URL (facultatif). Sans réglage SMTP : rien n'est envoyé,
le traitement continue. Un membre reçoit au plus un envoi par jour (users.newsletter_sent_at),
seulement s'il est actif, abonné (users.newsletter) et que l'e-mail a un contenu.
"""
import os
import re
import secrets
import smtplib
import ssl
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from html import escape

from . import members
from .util import log, norm

# Genre affiché : même règle que la fiche /partage/ (functions/partage/[[path]].js, displayGenre) :
# « Pop, Pop / Rock » donne « Pop » ; un lieu ou un instrument (« Église, Classique ») est sauté
NOT_GENRE = re.compile(r"^(eglise|piano|violon|orgue|guitare|concert a la bougie|concert de noel|"
                       r"choix de la redaction|music|other|undefined)$")


def display_genre(genre):
    parts = [p.strip() for p in str(genre or "").split(",") if p.strip()]
    return next((p for p in parts if not NOT_GENRE.match(norm(p))), None)


def smtp_port(value):
    """Port lu dans le secret SMTP_PORT ; espaces tolérés, 587 si la valeur est illisible."""
    text = str(value or "").strip()
    if text.isdigit():
        return int(text)
    if text:
        log(f"Newsletter : SMTP_PORT illisible, port 587 utilisé")
    return 587

SITE_URL = "https://concerts-s2k.pages.dev"
HORIZON_DAYS = 30
MAX_RECOMMENDED = 15
MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre",
          "octobre", "novembre", "décembre"]
DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MIN_GAP_DAYS = 6   # un envoi par semaine au plus, même si le traitement du lundi est relancé


def today_iso():
    """Date du jour à Paris (le traitement tourne en heure UTC)."""
    return datetime.now(ZoneInfo("Europe/Paris")).date().isoformat()


def smtp_settings():
    keys = ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD")
    if not all(os.environ.get(k) for k in keys):
        return None
    return {
        "host": os.environ["SMTP_HOST"],
        "port": smtp_port(os.environ.get("SMTP_PORT")),
        "user": os.environ["SMTP_USER"],
        "password": os.environ["SMTP_PASSWORD"],
        "sender": os.environ.get("NEWSLETTER_FROM") or os.environ["SMTP_USER"],
        "site": (os.environ.get("SITE_URL") or SITE_URL).rstrip("/"),
    }


def day_label(iso):
    d = date.fromisoformat(iso)
    return f"{DAYS[d.weekday()]} {d.day}{'er' if d.day == 1 else ''} {MONTHS[d.month - 1]}"


def headline(ev, item):
    if item.get("kind") == "known" and item.get("matched"):
        return ", ".join(m["name"] for m in item["matched"])
    if item.get("kind") == "discovery" and item.get("discovery"):
        return item["discovery"]["artist"]
    return ev.get("title") or "Concert"


def sections(events, overlay, going_ids, today=None):
    """Trois listes de (concert, entrée de l'overlay) : annoncés cette semaine, recommandés sur
    30 jours (hors annoncés), prochains concerts avec places prises."""
    today = today or today_iso()
    limit = (date.fromisoformat(today) + timedelta(days=HORIZON_DAYS)).isoformat()
    by_id = {ev["id"]: ev for ev in events if ev.get("date") and ev["date"] >= today}
    order = lambda pair: (pair[0]["date"], pair[0].get("time") or "")  # noqa: E731

    announced = [(ev, overlay[cid]) for cid, ev in by_id.items()
                 if overlay.get(cid, {}).get("kind") == "known"
                 and (ev.get("badge") == "annonce" or overlay[cid].get("badge") == "liste")]
    shown = {ev["id"] for ev, _ in announced}

    # Recommandations : vos artistes d'abord (niveau 1, puis 2, puis 3), puis les découvertes
    # les plus proches ; 15 au plus, présentées par date
    def relevance(pair):
        item = pair[1]
        if item.get("kind") == "known":
            return (0, item.get("tier") or 3, 0)
        return (1, 0, -(item.get("discovery") or {}).get("score", 0))
    candidates = [(ev, overlay[cid]) for cid, ev in by_id.items()
                  if cid not in shown and ev["date"] <= limit
                  and overlay.get(cid, {}).get("kind") in ("known", "discovery")]
    recommended = sorted(sorted(candidates, key=relevance)[:MAX_RECOMMENDED], key=order)

    going = [(by_id[cid], overlay.get(cid, {})) for cid in going_ids if cid in by_id]
    return sorted(announced, key=order), recommended, sorted(going, key=order)


def _row(ev, item, site):
    link = f"{site}/partage/{escape(ev['id'])}"
    when = day_label(ev["date"]) + (f" · {escape(ev['time'])}" if ev.get("time") else "")
    # Salle, style musical, et pour une découverte les artistes proches
    details = [escape(g) for g in [display_genre(ev.get("genre"))] if g]
    if item.get("kind") == "discovery":
        close = ", ".join((item.get("discovery") or {}).get("close_to", [])[:2])
        details.append(f"Découverte{f', proche de {escape(close)}' if close else ''}")
    tag_html = f' · <span style="color:#565b78">{" · ".join(details)}</span>' if details else ""
    return (f'<tr><td style="padding:10px 0;border-bottom:1px solid #d9dbe3">'
            f'<div style="font-size:13px;color:#565b78">{when}</div>'
            f'<div style="font-size:16px;font-weight:700;margin:2px 0">'
            f'<a href="{link}" style="color:#1e2350;text-decoration:none">{escape(headline(ev, item))}</a></div>'
            f'<div style="font-size:14px;color:#1e2350">{escape(ev.get("venue") or "")}{tag_html}</div></td></tr>')


def _block(title, rows, site, empty=None):
    if not rows and not empty:
        return ""
    body = "".join(_row(ev, item, site) for ev, item in rows) if rows else \
        f'<tr><td style="padding:8px 0;color:#565b78">{escape(empty)}</td></tr>'
    return (f'<h2 style="font-size:18px;color:#0078bf;margin:28px 0 4px">{escape(title)}</h2>'
            f'<table role="presentation" width="100%" cellspacing="0" cellpadding="0">{body}</table>')


def _text_block(title, rows, site):
    if not rows:
        return ""
    lines = [title.upper()]
    for ev, item in rows:
        when = day_label(ev["date"]) + (f" {ev['time']}" if ev.get("time") else "")
        genre = display_genre(ev.get("genre"))
        lines.append(f"- {when} : {headline(ev, item)}, {ev.get('venue') or ''}"
                     f"{f' ({genre})' if genre else ''} : {site}/partage/{ev['id']}")
    return "\n".join(lines) + "\n\n"


def build_email(name, announced, recommended, going, site, unsubscribe):
    """(objet, texte, HTML) ; None si les trois sections sont vides."""
    if not (announced or recommended or going):
        return None
    n = len(announced)
    subject = (f"Concerts à Paris : {n} annonce{'s' if n > 1 else ''} de vos artistes cette semaine" if n
               else "Concerts à Paris : vos recommandations de la semaine")
    titles = ("Annoncés cette semaine : vos artistes", f"Recommandés dans les {HORIZON_DAYS} prochains jours",
              "Vos prochains concerts")
    html = (f'<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>'
            f'<body style="margin:0;background:#e9ebef">'
            f'<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:Helvetica,Arial,sans-serif;color:#1e2350">'
            f'<h1 style="font-size:26px;color:#0078bf;margin:0 0 8px">Concerts à Paris</h1>'
            f'<p style="margin:0;font-size:15px">Bonjour {escape(name)}, voici votre sélection de la semaine.</p>'
            f'{_block(titles[0], announced, site, "Aucune nouvelle annonce de vos artistes cette semaine.")}'
            f'{_block(titles[1], recommended, site)}'
            f'{_block(titles[2], going, site)}'
            f'<p style="margin:28px 0 0"><a href="{site}" style="background:#0078bf;color:#fff;padding:10px 16px;'
            f'border-radius:6px;text-decoration:none;font-weight:700">Ouvrir Concerts à Paris</a></p>'
            f'<p style="margin:28px 0 0;font-size:12px;color:#565b78">Vous recevez cet e-mail chaque lundi en tant que '
            f'membre de Concerts à Paris. <a href="{unsubscribe}" style="color:#565b78">Ne plus recevoir la newsletter</a> '
            f'(réglable aussi dans « Mon compte »).</p></div></body></html>')
    text = (f"Bonjour {name}, voici votre sélection de la semaine.\n\n"
            + (_text_block(titles[0], announced, site) or "Aucune nouvelle annonce de vos artistes cette semaine.\n\n")
            + _text_block(titles[1], recommended, site) + _text_block(titles[2], going, site)
            + f"Ouvrir Concerts à Paris : {site}\n"
            + f"Ne plus recevoir la newsletter : {unsubscribe}\n")
    return subject, text, html


def recipients(db, today, test_member=None):
    """Membres actifs, abonnés, sans envoi depuis 6 jours (relance du traitement : pas de doublon).
    Essai : le seul membre désigné, abonné ou non, s'il n'est pas suspendu."""
    if test_member:
        return db.query("SELECT id, email, first_name, pseudo, newsletter_token FROM users "
                        "WHERE id = ? AND status <> 'suspended' AND email <> ''", [test_member])
    cutoff = (date.fromisoformat(today) - timedelta(days=MIN_GAP_DAYS)).isoformat()
    return db.query(
        "SELECT id, email, first_name, pseudo, newsletter_token FROM users "
        "WHERE status = 'active' AND newsletter = 1 AND email <> '' "
        "AND COALESCE(newsletter_sent_at, '') <= ? ORDER BY invited_at", [cutoff])


def token_for(db, member):
    if member.get("newsletter_token"):
        return member["newsletter_token"]
    token = secrets.token_urlsafe(24)
    db.query("UPDATE users SET newsletter_token = ? WHERE id = ? AND newsletter_token IS NULL", [token, member["id"]])
    rows = db.query("SELECT newsletter_token FROM users WHERE id = ?", [member["id"]])
    return rows[0]["newsletter_token"] if rows else token


def message(cfg, to, subject, text, html, unsubscribe):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("Concerts à Paris", cfg["sender"]))
    msg["To"] = to
    msg["Message-ID"] = make_msgid(domain=cfg["sender"].split("@")[-1])
    # Désabonnement en un clic depuis la messagerie (RFC 8058)
    msg["List-Unsubscribe"] = f"<{unsubscribe}>"
    msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    return msg


def connect(cfg):
    context = ssl.create_default_context()
    if cfg["port"] == 465:
        smtp = smtplib.SMTP_SSL(cfg["host"], 465, context=context, timeout=30)
    else:
        smtp = smtplib.SMTP(cfg["host"], cfg["port"], timeout=30)
        smtp.starttls(context=context)
    smtp.login(cfg["user"], cfg["password"])
    return smtp


def send_all(db, store, collected, cfg=None, today=None, test_member=None):
    """Envoie la newsletter à chaque membre concerné ; renvoie le nombre d'e-mails envoyés.
    Une erreur chez un membre est signalée et n'arrête pas les autres.
    test_member : essai pour ce seul membre (objet « [Essai] », envoi de la semaine non compté)."""
    cfg = cfg or smtp_settings()
    if not cfg:
        log("Newsletter : SMTP non configuré (secrets SMTP_HOST, SMTP_USER, SMTP_PASSWORD), aucun envoi")
        return 0
    today = today or today_iso()
    events = (collected or {}).get("events") or []
    try:
        targets = recipients(db, today, test_member)
    except Exception as exc:  # noqa: BLE001  migration 0008 pas encore appliquée, par exemple
        log(f"Newsletter : membres illisibles ({exc}), aucun envoi (migration 0008 appliquée ?)")
        return 0
    log(f"Newsletter d'essai pour {test_member} : {'membre trouvé' if targets else 'membre introuvable, suspendu ou sans e-mail'}"
        if test_member else f"Newsletter : {len(targets)} membre(s) abonné(s) à servir")
    sent, smtp = 0, None
    try:
        for m in targets:
            try:
                overlay = members.read(store, m["id"], "overlay", {}) or {}
                going = [r["concert_id"] for r in db.query(
                    "SELECT concert_id FROM stars WHERE user_id = ? AND status = 'going'", [m["id"]])]
                announced, recommended, going_rows = sections(events, overlay, going, today)
                unsubscribe = f"{cfg['site']}/partage/desabonnement/{token_for(db, m)}"
                built = build_email(m.get("pseudo") or m["first_name"], announced, recommended, going_rows,
                                    cfg["site"], unsubscribe)
                if not built:
                    log(f"  Membre {m['id']} : rien à envoyer (aucune annonce, recommandation ni place prise)")
                    continue
                if test_member:
                    built = (f"[Essai] {built[0]}",) + tuple(built[1:])
                mail = message(cfg, m["email"], *built, unsubscribe)
            except Exception as exc:  # noqa: BLE001  un membre en erreur n'arrête pas les autres
                log(f"  Membre {m['id']} : newsletter non préparée ({exc.__class__.__name__})")
                continue
            # Connexion : tout échec arrête l'envoi (mot de passe refusé, serveur injoignable)
            for attempt in (1, 2):
                try:
                    smtp = smtp or connect(cfg)
                except Exception as exc:  # noqa: BLE001
                    log(f"Newsletter : connexion SMTP impossible ({exc.__class__.__name__}), envoi arrêté")
                    return _done(sent)
                try:
                    smtp.send_message(mail)
                except smtplib.SMTPServerDisconnected:
                    smtp = None          # connexion perdue : un nouvel essai avec une connexion neuve
                    if attempt == 1:
                        continue
                    log(f"  Membre {m['id']} : newsletter non envoyée (connexion perdue)")
                    break
                except Exception as exc:  # noqa: BLE001  adresse refusée, par exemple
                    log(f"  Membre {m['id']} : newsletter non envoyée ({exc.__class__.__name__})")
                    break
                sent += 1
                if test_member:
                    log(f"  Membre {m['id']} : newsletter d'essai envoyée")
                    break
                try:
                    db.query("UPDATE users SET newsletter_sent_at = ? WHERE id = ?", [today, m["id"]])
                    log(f"  Membre {m['id']} : newsletter envoyée")
                except Exception as exc:  # noqa: BLE001
                    log(f"  Membre {m['id']} : newsletter envoyée, date d'envoi non enregistrée ({exc.__class__.__name__})")
                break
    finally:
        if smtp:
            try:
                smtp.quit()
            except Exception:  # noqa: BLE001
                pass
    return _done(sent)


def _done(sent):
    log(f"Newsletter : {sent} e-mail(s) envoyé(s)")
    return sent
