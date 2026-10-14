"""Notifications par e-mail (version 1.9.0) : file d'attente D1 (table notifications), envoyée
par SMTP (mêmes réglages que la newsletter : SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD,
NEWSLETTER_FROM).

Les fonctions du site ajoutent une ligne (inscription, connexion, source reliée, demande Spotify,
signalement « J'ai un problème ») puis lancent le workflow « Notifications » (notify.yml) ; le
traitement ajoute les siennes (premiers résultats, source à reconnecter, calcul en erreur, pause
Spotify) et envoie la file à la fin de chaque calcul. Une ligne non envoyée est retentée aux
passages suivants, 5 fois au plus.

À l'admin : tout membre de rôle admin (non suspendu). Au membre : son adresse de connexion.
Messages courts, sans jeton ni identifiant Spotify ; le texte d'un signalement est celui du membre.
"""
import json
import os
import smtplib
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from zoneinfo import ZoneInfo

from . import members
from .newsletter import SITE_URL, connect, smtp_settings
from .util import log

MAX_ATTEMPTS = 5
BATCH = 50
PARIS = ZoneInfo("Europe/Paris")

# Erreurs de calcul qui demandent une action de l'admin (message à l'admin)
ADMIN_ERRORS = {"internal", "token_key", "spotify_unconfigured", "storage_quota", "not_allowlisted",
                "unsupported_provider", "token_lost"}
# Erreurs qui demandent une action du membre (message au membre)
MEMBER_ERRORS = {"revoked", "private_profile", "not_found"}

ERROR_LABELS = {
    "quota": "Spotify limite temporairement les appels",
    "spotify_unavailable": "Spotify n'a pas répondu",
    "deezer_unavailable": "Deezer n'a pas répondu",
    "internal": "erreur interne du traitement",
    "token_key": "clé de chiffrement absente ou changée (TOKEN_ENC_KEY)",
    "spotify_unconfigured": "Spotify non configuré (secrets SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET)",
    "storage_quota": "stockage R2 plein",
    "not_allowlisted": "Spotify refuse le compte (absent de User Management)",
    "revoked": "accès Spotify expiré ou retiré",
    "private_profile": "profil Deezer devenu privé",
    "not_found": "profil Deezer introuvable",
    "token_lost": "jeton Spotify renouvelé mais non enregistré : le membre devra peut-être reconnecter Spotify",
}

STATUS_LABELS = {
    "invited": "invité", "onboarding": "accueil en cours (source à choisir)", "computing": "calcul en cours",
    "active": "actif", "error": "en erreur", "suspended": "suspendu",
}


def queue(db, kind, user_id=None, to_admin=False, payload=None, dedupe=None):
    """Ajoute un message à la file ; ignoré si la clé dedupe existe déjà."""
    db.query("INSERT OR IGNORE INTO notifications (kind, user_id, to_admin, payload, dedupe_key, created_at) "
             "VALUES (?, ?, ?, ?, ?, ?)",
             [kind, user_id, 1 if to_admin else 0, json.dumps(payload or {}, ensure_ascii=False), dedupe,
              members.now_iso()])


def when(iso):
    """« mercredi 14 octobre à 18:30 » (heure de Paris)."""
    try:
        d = datetime.fromisoformat(str(iso)).astimezone(PARIS)
    except ValueError:
        return str(iso)
    days = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
    months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre",
              "octobre", "novembre", "décembre"]
    return f"{days[d.weekday()]} {d.day} {months[d.month - 1]} à {d:%H:%M}"


def _name(user):
    return (user or {}).get("pseudo") or (user or {}).get("first_name") or "un membre"


def render(row, user, site):
    """(sujet, texte) du message, ou None si le message n'a plus lieu d'être."""
    p = json.loads(row.get("payload") or "{}")
    kind, name = row["kind"], _name(user)
    email = (user or {}).get("email", "")
    admin_link = f"Onglet Admin : {site}/?vue=admin"
    status = STATUS_LABELS.get((user or {}).get("status"), (user or {}).get("status") or "")

    if kind == "member_joined":
        spotify = "\nSource Spotify préparée : il lui reste à cliquer sur « Connecter Spotify »." if p.get("spotify") else ""
        return (f"Nouvelle inscription : {name}",
                f"{name} a utilisé son lien d'invitation avec l'adresse {email}.{spotify}\n\n"
                f"Vérifiez que cette adresse est bien la sienne.\n\n{admin_link}")
    if kind == "member_login":
        first = p.get("first")
        return (f"{'Première connexion' if first else 'Connexion'} de {name}",
                f"{name} ({email}) vient de se connecter{' pour la première fois' if first else ''}.\n"
                f"Statut : {status}.\n\n{admin_link}")
    if kind == "source_connected":
        provider = "Spotify" if p.get("provider") == "spotify" else "Deezer"
        return (f"{name} a relié {provider}",
                f"{name} ({email}) a relié son compte {provider}. Le calcul de ses concerts est lancé.\n\n{admin_link}")
    if kind == "spotify_request":
        return (f"{name} demande une place Spotify",
                f"{name} demande l'accès Spotify pour le compte suivant :\n"
                f"Nom : {p.get('account_name', '')}\nE-mail : {p.get('account_email', '')}\n\n"
                f"Ajoutez ce compte dans User Management chez Spotify, puis cliquez sur « Fait » dans l'onglet Admin.\n\n"
                f"{admin_link}")
    if kind == "problem_report":
        ctx = p.get("context") or {}
        lines = "\n".join(f"- {k} : {v}" for k, v in ctx.items() if v not in (None, ""))
        message = (p.get("message") or "").strip() or "(pas de message)"
        return (f"{name} signale un problème",
                f"{name} ({email}) a cliqué sur « J'ai un problème ».\n\nSon message :\n{message}\n\n"
                f"Contexte :\n- statut : {status}\n{lines}\n\n"
                f"Répondez directement à cet e-mail pour lui écrire.\n\n{admin_link}")
    if kind == "calc_error":
        code = p.get("code", "")
        return (f"Calcul en erreur : {name}",
                f"Le calcul de {name} ({email}) a échoué : {ERROR_LABELS.get(code, code)}.\n\n{admin_link}")
    if kind == "spotify_paused":
        return ("Spotify a suspendu les appels",
                f"Spotify refuse les appels de l'application (quota du compte développeur) jusqu'au {when(p.get('until'))}.\n"
                f"Les calculs Spotify en attente reprendront automatiquement ensuite ; rien à faire.\n"
                f"Membres concernés pour l'instant : {p.get('count', 1)}.\n\n{admin_link}")
    if kind == "results_ready":
        known, discovery = p.get("known", 0), p.get("discovery", 0)
        return ("Vos concerts sont prêts",
                f"Bonjour {name},\n\nLe calcul de vos concerts est terminé : {known} concert(s) de vos artistes "
                f"et {discovery} découverte(s) à Paris.\n\nOuvrir Concerts à Paris : {site}/\n\n"
                f"Un souci ? Bouton « J'ai un problème » en bas de chaque page.")
    if kind == "source_action":
        code = p.get("code")
        if code == "revoked":
            what = ("L'accès de Concerts à votre compte Spotify a expiré ou a été retiré. Vos concerts ne sont plus "
                    "mis à jour. Ouvrez le site et cliquez sur « Reconnecter Spotify » (moins d'une minute).")
        elif code == "private_profile":
            what = ("Votre profil Deezer est devenu privé : Concerts ne peut plus lire vos artistes. Dans les "
                    "paramètres de confidentialité de Deezer, rendez votre profil public.")
        else:
            what = "Votre profil Deezer est introuvable : vérifiez-le dans « Mon compte », ou choisissez une autre source."
        return ("Action nécessaire sur Concerts à Paris",
                f"Bonjour {name},\n\n{what}\n\nOuvrir Concerts à Paris : {site}/?vue=account\n\n"
                f"Un souci ? Bouton « J'ai un problème » en bas de chaque page.")
    if kind == "spotify_ready":
        return ("Votre accès Spotify est ouvert",
                f"Bonjour {name},\n\nVotre accès Spotify est ouvert. Ouvrez le site et cliquez sur « Connecter Spotify » : "
                f"le calcul de vos concerts démarrera aussitôt.\n\nOuvrir Concerts à Paris : {site}/")
    return None


def _message(cfg, to, subject, text, reply_to=None):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("Concerts à Paris", cfg["sender"]))
    msg["To"] = to
    msg["Message-ID"] = make_msgid(domain=cfg["sender"].split("@")[-1])
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(text)
    return msg


def _users(db, ids):
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    rows = db.query(f"SELECT id, email, first_name, pseudo, status FROM users WHERE id IN ({', '.join('?' * len(ids))})", ids)
    return {r["id"]: r for r in rows}


def send_pending(db, cfg=None):
    """Envoie les messages en attente ; renvoie le nombre d'e-mails envoyés."""
    cfg = cfg or smtp_settings()
    if not cfg:
        log("Notifications : SMTP non configuré, aucun envoi")
        return 0
    try:
        rows = db.query("SELECT id, kind, user_id, to_admin, payload, attempts FROM notifications "
                        "WHERE sent_at IS NULL AND attempts < ? ORDER BY id LIMIT ?", [MAX_ATTEMPTS, BATCH])
    except Exception as exc:  # noqa: BLE001  table absente (migration 0011 non appliquée)
        log(f"Notifications : file illisible ({exc.__class__.__name__})")
        return 0
    if not rows:
        return 0
    admins = [r["email"] for r in db.query("SELECT email FROM users WHERE role = 'admin' AND status <> 'suspended'")]
    users = _users(db, [r["user_id"] for r in rows])
    site = cfg.get("site") or (os.environ.get("SITE_URL") or SITE_URL).rstrip("/")
    sent, smtp = 0, None
    for row in rows:
        user = users.get(row["user_id"])
        content = render(row, user, site)
        to = admins if row["to_admin"] else ([user["email"]] if user else [])
        if not content or not to:
            db.query("UPDATE notifications SET sent_at = ?, last_error = 'sans objet' WHERE id = ?", [members.now_iso(), row["id"]])
            continue
        subject, text = content
        reply_to = user["email"] if row["to_admin"] and row["kind"] == "problem_report" and user else None
        try:
            smtp = smtp or connect(cfg)
            for address in to:
                smtp.send_message(_message(cfg, address, subject, text, reply_to))
            db.query("UPDATE notifications SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?",
                     [members.now_iso(), row["id"]])
            sent += 1
        except (smtplib.SMTPException, OSError) as exc:
            smtp = None
            db.query("UPDATE notifications SET attempts = attempts + 1, last_error = ? WHERE id = ?",
                     [exc.__class__.__name__, row["id"]])
            log(f"Notifications : envoi {row['id']} impossible ({exc.__class__.__name__})")
    if smtp:
        try:
            smtp.quit()
        except (smtplib.SMTPException, OSError):
            pass
    log(f"Notifications : {sent} e-mail(s) envoyé(s)")
    return sent
