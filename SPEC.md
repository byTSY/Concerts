# Concerts à Paris multi-membres : spécification

Statut : validée par l'admin, prête pour le développement. Version 2 du 12 octobre 2026
(ajout de Spotify comme source de bibliothèque).

## 0. Mode d'emploi pour la session de développement

- Ce document fait foi. En cas d'écart avec le code, le signaler avant de trancher.
- Développer étape par étape (section 17). Chaque étape se termine par une démonstration et
  un arrêt pour validation de l'admin avant l'étape suivante.
- Le site actuel reste en service à chaque étape. Rien n'est supprimé du dépôt avant que la
  reprise des données (section 14) soit vérifiée.
- Conventions du dépôt à conserver : code et commentaires en français, même style de
  journalisation (`util.log`), même normalisation des noms (`util.norm`, dupliquée en JS),
  README tenu à jour à chaque étape.
- Les actions à faire dans les consoles Cloudflare, GitHub et Spotify (section 16) sont
  réalisées par l'admin : les décrire pas à pas au moment où elles sont nécessaires.

## 1. Objet

Aujourd'hui, l'application sert un seul utilisateur : profil Deezer fixé dans
`config/settings.yaml`, préférences dans `config/artist_prefs.yaml`, résultats dans `data/`
et `site/data/`, commit dans le dépôt à chaque clic sur le site. L'objectif est de l'ouvrir à
un petit groupe (moins de 10 membres en phase de test) :

- chaque membre a son propre univers (bibliothèque musicale, artistes, découvertes, salles
  favorites, préférences, concerts mis de côté), qu'il gère seul ;
- chaque membre choisit sa source de bibliothèque : **Deezer** ou **Spotify** ;
- aucune donnée personnelle ne passe d'un membre à l'autre, sauf ce qu'un membre choisit
  explicitement de partager (section 12) ;
- un espace admin permet d'inviter, suspendre et supprimer des membres et de suivre
  l'exploitation.

## 2. Décisions arrêtées

| Sujet | Décision |
|---|---|
| Source Deezer | Lecture du profil public par son n°, sans identifiant ni mot de passe Deezer. |
| Source Spotify | Connexion OAuth Spotify (le membre autorise l'application chez Spotify). Jamais de mot de passe saisi dans l'application. |
| Une source par membre | Deezer ou Spotify, modifiable depuis Mon compte. |
| Moteur de découvertes | Graphe des artistes similaires Deezer pour tous les membres, y compris ceux sur Spotify (section 6.4). |
| Connexion à l'application | Cloudflare Access, code à usage unique reçu par e-mail. |
| Inscription | L'admin invite par un lien personnel (prénom seul ; la personne y saisit son e-mail) ou par e-mail et prénom ; le membre choisit et relie sa source à sa première connexion. Ajout du 13 octobre 2026. |
| Données personnelles | Hors de GitHub : Cloudflare D1 (base SQL) et R2 (fichiers). |
| Données communes | Concerts collectés, caches Deezer, salles observées : dans le dépôt, comme aujourd'hui. |
| Ce que voit l'admin | Statut, connexions, activité, nombre de concerts mis de côté (★), état de la synchronisation. Jamais le contenu (artistes, concerts choisis, préférences). |
| Révocation | Suspendre (accès coupé, données gardées) ou supprimer (données effacées). |
| Console admin | Toute la gestion des membres se fait depuis la console Concert. Seul geste hors de Concert : ajouter ou retirer un membre Spotify chez Spotify, par un lien direct et des informations copiables en un clic (section 10). |
| Suppression par le membre | Possible depuis Mon compte, double confirmation. |
| Nom affiché | Prénom saisi par l'admin ; le membre peut le remplacer par un pseudo. |
| Communauté v1 | Catalogue des salles commun, ★ visibles des membres au choix du membre, statut « j'y vais ». |
| Nouvelle salle | Proposée par un membre, publiée après validation de l'admin. |
| Réglages communs | Zone (Paris, 12 km), horizon (12 mois), barème du score. |
| Historique git | Les données personnelles de l'admin déjà présentes dans l'historique y restent ; purge facultative, hors périmètre. |

## 3. Existant (état au commit `d5754be`, 12 octobre 2026)

| Élément | Rôle actuel | Devenir |
|---|---|---|
| `src/main.py` | Enchaîne Deezer, sources, rapprochement, découvertes, historique, publication | Découpé en étape commune et boucle par membre ; options `--member` |
| `src/deezer.py` | `refresh_artists` (profil fixe, `SystemExit` si introuvable), `search_artist`, `related`, caches | `refresh_artists(deezer_id)` sans `SystemExit` ; recherche et similaires inchangés (communs) |
| `src/sources/*` | Ticketmaster, Bandsintown (par artiste), Que faire à Paris, Offi (c. 10 min), Dice (c. 3 min, salles en cache), pages des salles | Étape commune ; Bandsintown reçoit l'union des artistes des membres |
| `src/match.py` | `VenueMatcher` (favorites de `venues.yaml`), `prepare` pose `venue_favorite`, `ArtistIndex`, `match_known`, `dedupe` | Salle canonique dans l'étape commune ; `venue_favorite` calculé par membre |
| `src/discover.py` | Découvertes à partir de la liste, bonus salle favorite, plafond `max_new_lookups` | Par membre ; caches communs |
| `src/history.py` | Base des concerts : `first_seen`, badge « annonce » (commun) et `list_since`, badge « liste » (personnel), base initiale | Découpé en partie commune et partie membre |
| `src/publish.py` | Écrit `site/data/{events,artists,venues,meta}.json` | Commun : tous les concerts, salles observées, sources. Membre : fichiers R2 |
| `config/settings.yaml` | Profil Deezer, zone, horizon, barème, paramètres découvertes | `deezer_user_id` retiré ; ajout du poids `top_artist` (section 6.3) |
| `config/venues.yaml` | 8 salles favorites avec alias et `agenda_url` ; `excluded` | Devient le catalogue commun en D1 |
| `config/artist_prefs.yaml` | Masqués, niveaux, ★ (un commit par clic) | Importé en D1 puis retiré |
| `functions/api/prefs.js` | Lit et écrit `artist_prefs.yaml` via l'API GitHub | Remplacé par `/api/me/*` |
| `functions/partage/[[path]].js` | Fiche publique d'un concert ; Wikidata, Deezer ; lien Spotify exact via Wikidata ou API Spotify (identifiants client `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, cache 7 jours) | Inchangé ; partage le quota Spotify avec les synchronisations (section 6.5) |
| `site/app.js` | Charge `data/*.json` et `api/prefs` | Charge les données communes en statique et les données personnelles via `/api/me/*` |
| `.github/workflows/weekly.yml` | Lundi 5h UTC, délai 60 min, commit des données | Deux tâches (commune, membres) et lancement manuel pour un membre |

## 4. Architecture

```
GitHub (dépôt privé)                    Cloudflare
  code                                    Access : liste d'e-mails autorisés
  données communes : concerts,            Pages : site statique + fonctions /api/*
    caches Deezer, salles observées       D1 : membres, sources, préférences, salles, ★, traitements
  Actions : traitement du lundi    ───►   R2 : résultats calculés par membre (users/<id>/…)
            + calcul d'un membre
                                          Spotify : OAuth et API Web (membres Spotify)
                                          Deezer : API publique (tous)
```

- Le traitement (Python, GitHub Actions) lit D1 par l'API REST Cloudflare (`/d1/database/{id}/query`)
  et écrit dans R2 par l'API compatible S3 (`boto3`). Jetons limités à D1 et R2.
- Les fonctions Pages accèdent à D1 et R2 par leurs liaisons (`env.DB`, `env.BUCKET`).

## 5. Identité, rôles, isolation

### 5.1 Deux barrières

1. **Cloudflare Access** n'autorise que les e-mails de la liste « membres » (liste Zero Trust
   tenue à jour par l'espace admin, et par la page d'invitation quand une personne y saisit son
   adresse).
2. **L'application** vérifie le jeton `Cf-Access-Jwt-Assertion` (signature contre les
   certificats `https://<équipe>.cloudflareaccess.com/cdn-cgi/access/certs`, audience
   `ACCESS_AUD`), en extrait l'e-mail et cherche le membre dans `users`. E-mail absent, statut
   `suspended` ou compte supprimé : 403.

La seconde barrière rend la suspension immédiate, même avec une session Access ouverte.

### 5.2 Rôles

`member` : son univers et la communauté. `admin` : idem, plus `/api/admin/*`. Le premier admin
est créé par la migration initiale (variable `ADMIN_EMAIL`).

### 5.3 Règles de code (sans exception)

- Routes personnelles sous `/api/me/*`. **Aucune requête ne transporte d'identifiant de
  membre** : le serveur le déduit du jeton vérifié.
- Un seul module d'accès (`functions/_lib/me.js`) pour les tables personnelles et le préfixe
  R2 `users/<id>/` : il ajoute toujours `user_id = <membre connecté>`. Aucune autre partie du
  code n'interroge directement ces tables ou ce préfixe.
- Objets R2 jamais publics ; seule l'API les sert.
- `/api/admin/*` vérifie le rôle avant toute autre opération.
- Journaux (traitement, fonctions) : identifiants de membre, compteurs, erreurs. Jamais de nom
  d'artiste ni d'identifiant de concert associé à un membre, jamais de jeton.
- Identifiants de membre opaques (`u_` + 8 caractères aléatoires).

## 6. Sources musicales

### 6.1 Interface commune

Chaque source fournit, pour un membre, la même structure que `deezer.refresh_artists`
aujourd'hui : par artiste, nom, lien, image, compteurs (favori, albums, titres, playlists,
top), date du like le plus récent. Le reste du traitement ne dépend pas de la source.

```
src/library/base.py      structure commune, calcul du score et du niveau
src/library/deezer.py    profil public (code actuel de deezer.refresh_artists)
src/library/spotify.py   OAuth (rafraîchissement du jeton) et lecture de la bibliothèque
```

Une erreur de source lève une exception propre au membre (`SourceError` avec un code :
`private_profile`, `not_found`, `revoked`, `not_allowlisted`, `quota`, `spotify_unavailable`),
jamais `SystemExit`.

### 6.2 Deezer

Inchangé sur le fond : `/user/{id}/artists`, `/albums`, `/tracks`, playlists créées par le
membre. Profil public obligatoire. Vérification au rattachement par `/user/{id}`.

### 6.3 Spotify

**Contraintes Spotify (vérifiées le 12 octobre 2026, section 18)** : une application en mode
développement exige que son propriétaire ait un abonnement **Spotify Premium** actif (sinon
elle cesse de fonctionner) ; elle est limitée à **5 utilisateurs** pour les applications créées
depuis le 11 février 2026 ; chaque utilisateur doit être ajouté **à la main** par le
propriétaire dans le tableau de bord Spotify (nom et e-mail du compte Spotify), sinon les
appels renvoient 403. Le passage au quota étendu n'est pas envisageable pour un particulier.

Conséquence : `SPOTIFY_MAX_USERS = 5` en configuration. Au-delà, l'option Spotify est grisée
à l'inscription avec un message. Point à vérifier en étape 4 : le compte propriétaire
compte-t-il dans les 5 ?

**Autorisation** : flux Authorization Code avec PKCE, échange du code côté serveur (fonction
Pages, avec le secret client). Portées demandées :
`user-library-read user-follow-read user-top-read playlist-read-private playlist-read-collaborative`.
Adresse de retour : `https://concerts-s2k.pages.dev/api/me/spotify/callback` (à déclarer dans
le tableau de bord Spotify, correspondance exacte).

**Jetons** : seul le jeton de rafraîchissement est conservé, chiffré (AES-GCM, secret
`TOKEN_ENC_KEY` partagé par Pages et Actions). Le jeton d'accès (1 h) n'est jamais stocké.
Si Spotify renvoie un nouveau jeton de rafraîchissement, il remplace l'ancien. Réponse
`invalid_grant` : source en statut `revoked`, le membre voit « Reconnecter Spotify ».

**Lecture** (points d'accès disponibles en mode développement selon le changelog de février
2026) :

| Signal | Point d'accès | Équivalent Deezer | Poids |
|---|---|---|---|
| Artistes suivis | `GET /me/following?type=artist` (curseur, 50 par page) | artiste favori | `favorite_artist` (5) |
| Albums sauvegardés | `GET /me/albums` (50 par page, `added_at`) | album liké | `liked_album` (2) |
| Titres likés | `GET /me/tracks` (50 par page, `added_at`) | titre liké | `liked_track` (1) |
| Titres des playlists du membre | `GET /me/playlists` puis `GET /playlists/{id}/items` (contenu renvoyé seulement pour les playlists possédées ou collaboratives) | playlists personnelles | `playlist_track` (0,25) |
| Artistes les plus écoutés | `GET /me/top/artists?time_range=long_term` et `medium_term` | aucun | `top_artist` (3, nouveau, à calibrer) |

Points à ne pas utiliser : `GET /users/{id}/playlists`, `GET /playlists/{id}/tracks`,
`GET /artists` (lot), `GET /artists/{id}/top-tracks` (supprimés en février 2026) ;
`GET /artists/{id}/related-artists` et `GET /recommendations` (fermés aux nouvelles
applications depuis le 27 novembre 2024). Recherche limitée à 10 résultats par appel.

Date d'ajout : `added_at` des titres et albums ; les artistes suivis n'en ont pas.

### 6.4 Identité des artistes et découvertes

Les découvertes reposent sur les artistes similaires Deezer (`deezer.related`), indisponibles
côté Spotify. Chaque artiste Spotify est donc rapproché d'un artiste Deezer par
`deezer.search_artist` (cache commun) avec les règles de `match.py` contre les homonymes.

- Rapproché : l'artiste est identifié par son id Deezer, l'id Spotify est conservé (lien
  d'écoute).
- Non rapproché : identifiant `sp:<id>` ; il sert au rapprochement des concerts par nom, pas
  au calcul des découvertes. Compteur visible dans les journaux.

Les préférences (`artist_prefs`) étant indexées par nom normalisé, elles survivent à un
changement de source.

### 6.5 Quotas

Deezer : pause actuelle conservée (c. 50 requêtes par 5 secondes). Spotify : respecter
`Retry-After` sur 429 (`reason: QUOTA_EXCEEDED`). Depuis juillet 2026, le quota de mode
développement est compté par compte développeur : la fonction de partage (recherche
d'artistes) et les synchronisations partagent le même quota. Pause entre appels et lecture
des membres Spotify l'un après l'autre.

### 6.6 Synchronisation

- Automatique : chaque lundi, pour tous les membres actifs.
- À la demande : bouton « Synchroniser maintenant » dans Mon compte (Deezer et Spotify),
  limité à une fois par heure ; lance le calcul du membre (section 8.2) ; affichage « en
  cours » puis date de la dernière synchronisation.

## 7. Modèle de données

### 7.1 D1

**users** : `id` (PK, `u_xxxxxxxx`), `email` (unique, minuscules), `first_name`, `pseudo`
(unique, nullable), `role` (`admin` / `member`), `status` (`invited` / `onboarding` /
`computing` / `active` / `error` / `suspended`), `default_visibility` (`private` /
`members`, défaut `private`), `error_message`, `invited_at`, `activated_at`,
`suspended_at`, `last_seen_at`. Nom affiché = `pseudo` sinon `first_name`.

Ajout de la version 1.5.0 à **users** : `newsletter` (1 par défaut), `newsletter_token` (jeton du
lien de désabonnement), `newsletter_sent_at` (date du dernier envoi).

**music_sources** (une ligne par membre) : `user_id` (PK), `provider` (`deezer` / `spotify`),
`provider_user_id` (unique par fournisseur), `provider_name` (nom du profil, visible du
membre seul), `status` (`pending_allowlist` / `ready_to_connect` / `connected` / `error` /
`revoked`), `spotify_account_email` et `spotify_account_name` (pour l'ajout dans le tableau
de bord Spotify), `refresh_token_enc`, `scopes`, `connected_at`, `last_sync_at`,
`last_sync_status`, `sync_requested_at`, `sync_relayed_at` et `sync_relay_count` (version 1.2.1 : dernier relais du calcul par le site,
nombre de relais pour la demande en cours, 3 au plus).

**oauth_states** : `state` (PK), `user_id`, `code_verifier`, `expires_at` (10 min), à usage
unique.

**invitations** (ajout du 13 octobre 2026) : `id` (`i_` + 8 caractères), `token_hash` (empreinte
SHA-256 du jeton du lien, jamais le jeton), `first_name`, `created_at`, `expires_at` (7 jours).
Ligne effacée quand le lien sert ; un lien expiré reste listé jusqu'à sa suppression par
l'admin. `users` reçoit `invited_via` (`email` / `link`) et `access_pending` (ajout à la liste
Access à refaire).

**connections** : `user_id`, `session_started_at`. Une connexion = un jeton Access dont la
valeur `iat` n'a jamais été vue pour ce membre.

**activity_daily** : `user_id`, `day`, `api_calls`, `changes`.

**artist_prefs** : `user_id`, `artist_key`, `artist_name`, `hidden`, `level` (null, 1, 2, 3),
`updated_at`. Clé (`user_id`, `artist_key`).

**venue_favorites** : `user_id`, `venue_id`, `added_at`.

**stars** : `user_id`, `concert_id`, `label`, `status` (`interested` / `going`),
`visibility` (`private` / `members`), `created_at`, `updated_at`. Clé (`user_id`,
`concert_id`).

**seen_cards** (ajout de la version 1.2.0) : `user_id`, `concert_id`, `seen_at`. Fiches Reels déjà
vues ; lignes de plus de 400 jours effacées à l'écriture.

**venues** (catalogue commun) : `id`, `name`, `aliases` (JSON), `agenda_url`, `excluded`,
`status` (`pending` / `approved` / `rejected`), `proposed_by` (nullable, remis à null à la
suppression du membre), `proposed_at`, `reviewed_at`, `review_note`.

**runs** : `id`, `kind` (`weekly` / `member`), `started_at`, `ended_at`, `status`,
`sources` (JSON).

**member_runs** : `run_id`, `user_id`, `provider`, `status` (`ok` / `error`), `error_code`,
`duration_s`. Aucun contenu.

### 7.2 R2

```
users/<id>/artists.json    artistes, score, niveau, source (deezer / spotify), ids Deezer et Spotify
users/<id>/overlay.json    concerts retenus : id → kind, niveau, artistes rapprochés, découverte, badge, venue_favorite
users/<id>/history.json    base initiale et list_since de chaque concert
users/<id>/meta.json       date du calcul, compteurs du bandeau
```

### 7.3 Dépôt (commun)

`data/concerts.json` (partie commune : identifiant stable, `first_seen`), `data/cache/*`
(recherche, similaires, salles Dice), `site/data/events.json` (tous les concerts, sans
champ personnel), `site/data/venues.json` (salles observées, avec id du catalogue quand il
existe), `site/data/meta.json` (état des sources).

## 8. Traitement

### 8.1 Traitement du lundi : deux tâches dans `weekly.yml`

1. **Tâche commune** (délai 60 min) : catalogue des salles approuvées (D1), collecte des
   sources, salle canonique, dédoublonnage, historique commun (`first_seen`, badge
   « annonce »), publication commune, commit. Bandsintown reçoit l'union des artistes de
   niveaux 1 et 2 de tous les membres (lue dans R2), plafond à régler en étape 6.
2. **Tâche membres** (`needs` la première, délai 60 min) : pour chaque membre `active` ou
   `error` : lecture de la source → préférences (D1) → `match_known` → `venue_favorite` →
   `score_events` → historique du membre → écriture R2 → `member_runs`. Commit des caches
   communs enrichis (`git pull --rebase` avant `push`).

Une erreur chez un membre le passe en `error` (avec `error_code`) et le traitement continue.

### 8.2 Calcul d'un seul membre

`python -m src.main --member <id>` : tâche membres pour ce seul membre, à partir des concerts
de la dernière collecte. Lancé par l'API (`workflow_dispatch`, paramètre `member`) à
l'arrivée d'un membre, au changement de source, sur « Synchroniser maintenant » ou à la
demande de l'admin. Le groupe de concurrence est conservé : les calculs passent l'un après
l'autre.

Relais (version 1.2.1) : à l'ouverture du site (`GET /api/me`), un calcul demandé depuis plus de
15 minutes et resté sans résultat est relancé, au plus une fois par 15 minutes et par membre
(`sync_relayed_at`), 3 fois au plus par demande, jamais le lundi de 5 h à 9 h UTC ; la relance
de sécurité des 2 heures reste en complément. `last_sync_at` reçoit l'heure de début du calcul. Avec `--pending`,
un membre désigné qui n'attend plus de calcul est ignoré.

Premier calcul d'un membre (ou changement de source) : base initiale du membre, aucun badge
« liste » ce jour-là.

### 8.3 À mesurer

Durée des deux tâches avec 5 à 10 membres ; nombre d'appels Spotify par membre ; taux
d'artistes Spotify non rapprochés de Deezer.

## 9. API

### 9.1 Membre

| Méthode et route | Rôle |
|---|---|
| `GET /api/me` | profil, statut, nom affiché, visibilité par défaut, source et état de synchronisation |
| `PATCH /api/me` | pseudo, visibilité par défaut |
| `POST /api/me/source/deezer` | `{ profile }` (URL ou n°) : vérifie le profil public, renvoie un aperçu |
| `POST /api/me/source/deezer/confirm` | rattache le profil, lance le calcul |
| `POST /api/me/source/spotify/request` | `{ account_email, account_name }` : statut `pending_allowlist`, refusé si les places Spotify sont prises |
| `GET /api/me/spotify/authorize` | crée `oauth_states`, redirige vers Spotify (seulement si `ready_to_connect`, `revoked` ou `connected`) |
| `GET /api/me/spotify/callback` | vérifie `state` et que le membre connecté est celui de `state`, échange le code, `GET /me`, contrôle d'unicité, enregistre le jeton chiffré, lance le calcul ; 403 Spotify « non enregistré » : retour à `pending_allowlist` avec message |
| `POST /api/me/sync` | « Synchroniser maintenant » (une fois par heure) |
| `DELETE /api/me/source` | détache la source (supprime le jeton) avant d'en choisir une autre |
| `GET /api/me/artists` | `artists.json` du membre |
| `GET /api/me/concerts` | `overlay.json` et `meta.json` |
| `PUT /api/me/artists/:key` | `{ hidden?, level? }` |
| `PUT` / `DELETE /api/me/venues/:id` | salle favorite |
| `GET /api/me/stars` | ses ★ |
| `PUT /api/me/stars/:concert` | `{ label, status, visibility }` |
| `DELETE /api/me/stars/:concert` | retrait |
| `GET /api/me/seen` | fiches Reels déjà vues (version 1.2.0) |
| `POST /api/me/seen` | `{ ids }` (50 au plus) : fiches vues |
| `DELETE /api/me` | suppression de son compte (double confirmation) |

### 9.2 Communauté

| Méthode et route | Rôle |
|---|---|
| `GET /api/community/stars` | ★ en visibilité `members` des membres actifs : concert, nom affiché, statut. Jamais un ★ privé. |
| `GET /api/venues` | catalogue approuvé |
| `POST /api/venues/proposals` | `{ name, aliases?, agenda_url? }`, statut `pending` |

### 9.3 Admin

| Méthode et route | Rôle |
|---|---|
| `GET /api/admin/members` | par membre : nom affiché, e-mail, statut, source (Deezer / Spotify), état de synchronisation, dernière connexion, connexions et activité sur 30 jours, nombre de ★ |
| `POST /api/admin/members` | invitation `{ email, first_name }` ; ajout à la liste Access ; renvoie le lien à transmettre |
| `GET` / `POST /api/admin/invitations` | liens d'invitation en attente ; nouveau lien `{ first_name }` (jeton aléatoire, empreinte seule gardée, usage unique, 7 jours) |
| `POST /api/admin/invitations/:id/renew`, `DELETE /api/admin/invitations/:id` | nouveau lien (l'ancien ne marche plus), suppression |
| `GET /api/admin/spotify` | places utilisées / `SPOTIFY_MAX_USERS` ; demandes à ajouter (nom et e-mail du compte Spotify) ; comptes à retirer après suppression |
| `POST /api/admin/spotify/:user/allowlisted` | l'admin confirme l'ajout dans le tableau de bord Spotify : `ready_to_connect` |
| `POST /api/admin/spotify/:user/removed` | l'admin confirme le retrait : place libérée, nom et e-mail Spotify effacés |
| `POST /api/admin/members/:id/suspend` | statut `suspended`, retrait de la liste Access, révocation des sessions |
| `POST /api/admin/members/:id/reactivate` | retour au statut précédent, ajout à la liste Access |
| `DELETE /api/admin/members/:id` | suppression complète (section 13.3) |
| `POST /api/admin/members/:id/recompute` | calcul du membre |
| `GET /api/admin/venues?status=pending` | salles à valider |
| `POST /api/admin/venues/:id/approve` / `reject` | décision, note facultative |
| `PATCH /api/admin/venues/:id` | correction (alias, page programme, exclusion) |
| `GET /api/admin/runs` | traitements, état des sources, erreurs par membre (codes seulement) |
| `POST /api/admin/runs` | relance du traitement du lundi |

### 9.4 Public

`/partage/*` : inchangé (application Access séparée, ouverte à tous).
`/invitation/<jeton>` : page d'inscription par lien (même application Access ouverte à tous) ;
formulaire de cette page seulement, en-têtes `no-store`, `referrer-policy: same-origin`, CSP
sans script.

## 10. Écrans

**Membre** : onglets actuels (Calendrier, Liste, Par artiste, ★ Intéressés, Mes artistes,
Salles), plus **Mon compte** : nom affiché et pseudo ; source (Deezer ou Spotify, nom du
profil, dernière synchronisation, « Synchroniser maintenant », « Changer de source ») ;
visibilité par défaut des ★ ; suppression du compte. Dans Salles : « Proposer une salle ».
Fiche d'un concert : bloc « Membres », choix privé / visible lors de la mise de côté, statut
« j'y vais ». Liens d'écoute : Spotify en premier pour un membre Spotify.

**Admin** (onglet visible du seul admin) : **Membres** (tableau et actions), **Spotify**
(places, demandes à ajouter avec bouton copier, comptes à retirer), **Salles à valider**,
**Traitements**.

**Principe : l'admin pilote tout depuis la console Concert.** Il ne va dans la console Spotify
que pour l'unique geste que Spotify n'expose pas en API (ajouter ou retirer un utilisateur),
et il y arrive par un lien direct, avec les informations déjà prêtes à coller.

Onglet **Spotify** de la console admin :

- **Compteur de places** : « 3 / 5 places utilisées ».
- **Demandes à traiter**, une carte par membre :
  - nom affiché du membre dans Concert et date de la demande ;
  - champ **Nom** (tel que saisi par le membre) avec un bouton **Copier** ;
  - champ **E-mail du compte Spotify** avec un bouton **Copier** ;
  - bouton **Ouvrir Spotify** : lien direct, dans un nouvel onglet, vers la page User
    Management de l'application dans le tableau de bord Spotify, construit à partir de
    `SPOTIFY_CLIENT_ID` (format exact de l'URL à vérifier à l'étape 4 ; à défaut, lien vers la
    page de l'application dans le tableau de bord) ;
  - rappel en une ligne : « Add new user, collez le nom puis l'e-mail, Save » ;
  - bouton **Fait** : passe la source du membre en `ready_to_connect` et lui affiche
    « Connecter Spotify ».
- **Retraits à faire** (après suppression d'un membre Spotify) : même carte, avec e-mail à
  copier, bouton **Ouvrir Spotify** et bouton **Retiré** qui libère la place et efface
  définitivement le nom et l'e-mail Spotify conservés pour cette tâche.
- Chaque bouton **Copier** copie la valeur exacte (sans espace ajouté) dans le
  presse-papiers en un clic et affiche « Copié » pendant 2 secondes. Repli si le
  presse-papiers est indisponible : la valeur est sélectionnée dans un champ en lecture seule.
- Si le membre retente la connexion et que Spotify répond « utilisateur non enregistré », la
  carte revient dans les demandes à traiter avec la mention « Spotify refuse encore ce compte :
  vérifier l'e-mail ».

Aucune autre action dans les consoles Spotify, Cloudflare ou GitHub n'est nécessaire pour
gérer les membres au quotidien : invitation, suspension, réactivation, suppression,
validation des salles et relance des calculs se font dans la console Concert.

## 11. Arrivée d'un membre : choix de la source

1. L'admin invite : soit par un lien personnel créé pour un prénom, que la personne ouvre
   (`/invitation/<jeton>`, chemin ouvert à tous dans Access, comme `/partage`) pour y saisir son
   adresse, alors inscrite et ajoutée à la liste Access ; soit par e-mail et prénom. Il transmet
   lui-même le lien (bouton « Partager » : WhatsApp, Messenger, Messages, e-mail).
2. Le membre se connecte (code Access). Statut `onboarding`. Texte court sur les données
   conservées (e-mail, prénom ou pseudo, source musicale, préférences) et la suppression
   possible à tout moment.
3. **Choix de la source.**
   - **Deezer** : URL ou n° du profil ; vérification du profil public ; aperçu (nom, nombre
     d'artistes favoris) à confirmer. Profil privé : réglage Deezer à modifier indiqué.
   - **Spotify** (grisé si les places sont prises) : formulaire rempli par le membre, pour que
     l'admin n'ait rien à demander ni à ressaisir :
     - **Nom** (prénom et nom, prérempli avec le nom affiché, modifiable) ;
     - **E-mail du compte Spotify**, avec une aide : « celui de la page Compte > Modifier le
       profil sur spotify.com, il peut différer de votre e-mail de connexion à Concert » et un
       lien vers cette page ; contrôle de format ; saisie en double pour éviter les fautes de
       frappe ;
     - case à cocher : « J'accepte que l'admin ajoute ce compte à l'application Concerts chez
       Spotify ».
     Après envoi : écran d'attente « Autorisation en cours par l'admin », avec possibilité de
     corriger l'e-mail. Quand l'admin a cliqué « Fait » (section 10), le membre voit
     « Connecter Spotify », autorise l'application chez Spotify et revient sur le site.
   - Profil (Deezer ou Spotify) déjà rattaché à un autre membre : refus.
4. Salles favorites (facultatif).
5. Calcul du membre : `computing`, puis `active`. Écran d'attente avec rafraîchissement.

## 12. Communauté v1

**Principe : rien de personnel n'est visible par défaut.** Chaque élément partagé résulte
d'une action du membre et peut être retiré.

- **★ partagés** : à la mise de côté, « privé » (défaut, réglable) ou « visible par les
  membres ». Fiche du concert : « Intéressés : Marie, Paul » et « Y vont : Léa ». Filtre
  « Avec les membres ».
- **« Places prises »** (ancien « J'y vais », renommé en version 1.3.0) : second niveau du ★ (`going`),
  même règle de visibilité.
- **Catalogue des salles** : proposition par un membre, validation par l'admin, salle utile à
  tous ; les membres ne voient pas qui l'a proposée.
- Suspension ou suppression d'un membre : ses ★ partagés disparaissent aussitôt.

Hors v1 : compteur « populaire chez les membres » (seuil minimal de 3 si ajouté), affinités
entre membres.

## 13. Cycle de vie

### 13.1 Salles favorites

Le membre choisit dans le catalogue approuvé. Une salle observée dans les sources mais absente
du catalogue se propose en un clic (nom prérempli), puis attend la validation de l'admin.

### 13.2 Changement de source

Depuis Mon compte, après confirmation : détachement (jeton Spotify supprimé), nouveau choix
(section 11, étape 3), calcul. Historique du membre remis à zéro ; préférences, salles et ★
conservés.

### 13.3 Suppression

Par l'admin ou le membre : lignes du membre supprimées dans toutes les tables (dont le jeton
chiffré), objets `users/<id>/` supprimés, retrait de la liste Access, révocation des
sessions, `venues.proposed_by` à null. Membre Spotify : tâche « retirer du tableau de bord
Spotify » affichée à l'admin (action manuelle, libère la place) ; le membre est invité à
retirer l'accès depuis la page des applications de son compte Spotify. Journal :
identifiant et date seulement.

## 14. Reprise de l'existant

1. Compte admin créé en D1, source Deezer `1836006062`.
2. Import de `config/artist_prefs.yaml` (masqués, niveaux, ★ en `private`, libellés
   conservés) et de `config/venues.yaml` (catalogue approuvé ; les 8 salles deviennent vos
   favorites).
3. Import de `data/artists.json` et de la partie personnelle de `data/concerts.json`
   (`list_since`, base initiale) dans R2.
4. Vérification : le site affiche pour vous les mêmes concerts, artistes, niveaux et ★
   qu'avant (comparaison automatique des listes d'identifiants).
5. Seulement ensuite : retrait du dépôt de `config/artist_prefs.yaml`, `data/artists.json`,
   `data/events.json`, `site/data/artists.json`, de `deezer_user_id` dans `settings.yaml`, et
   de `functions/api/prefs.js`. Retrait du jeton GitHub à droit d'écriture sur le contenu.

## 15. Sécurité, secrets, configuration

| Secret ou variable | Où | Usage |
|---|---|---|
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Pages | vérification du jeton Access |
| `ADMIN_EMAIL` | Pages, migration | premier admin |
| `CF_ADMIN_API_TOKEN` | Pages (secret) | liste Access « membres », révocation de sessions |
| `GITHUB_ACTIONS_TOKEN` | Pages (secret) | lancement d'un calcul (`workflow_dispatch`), droit Actions seulement |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Pages (existants) et Actions | OAuth, rafraîchissement, fiche de partage |
| `SPOTIFY_MAX_USERS` | Pages | 5 |
| `TOKEN_ENC_KEY` | Pages et Actions (secret) | chiffrement des jetons Spotify |
| `CF_ACCOUNT_ID`, `D1_DATABASE_ID`, `CF_D1_API_TOKEN` | Actions | lecture et écriture D1 |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Actions | lecture et écriture R2 |
| `TICKETMASTER_API_KEY`, `BANDSINTOWN_APP_ID` | Actions | inchangés |

Dépendances Python à ajouter : `boto3`, `cryptography`.

Environnement de prévisualisation (déploiements de branche Pages) relié à une base D1 et un
compartiment R2 distincts, avec des membres fictifs ; Spotify testé avec le compte de
l'admin.

## 16. Prérequis à réaliser par l'admin (guidés le moment venu)

- Cloudflare : création de la base D1 et du compartiment R2 (production et prévisualisation),
  liaisons au projet Pages, liste Zero Trust « membres » et règle Access qui l'utilise,
  jetons API aux droits limités, relevé de l'équipe Access et de l'audience.
- GitHub : secrets Actions ; jeton limité aux Actions du dépôt.
- Cloudflare Access : chemin `concerts-s2k.pages.dev/invitation` ouvert à tous, dans la même
  application que `/partage` (ajout du 13 octobre 2026).
- Spotify : l'application `Concerts` existe déjà (identifiants enregistrés dans Cloudflare,
  utilisés par la fiche de partage). Confirmer que le compte Spotify qui la possède a un
  abonnement **Premium** actif (page Compte de spotify.com) ; ajouter l'adresse de retour
  `/api/me/spotify/callback`. Ensuite, l'ajout de chaque membre Spotify se fait depuis
  l'onglet Spotify de la console Concert (section 10). L'admin
  reste sur Deezer comme membre ; son compte Spotify ne sert qu'à posséder l'application,
  sauf pour le test de l'étape 4.

## 17. Étapes et critères de validation

1. **Socle** : D1, R2, vérification Access, module d'accès, reprise de l'existant.
   *Validé quand* le site fonctionne pour l'admin comme aujourd'hui, données personnelles
   servies par `/api/me/*`, comparaison de reprise sans écart.
2. **Traitement multi-membres** : interface de source, Deezer porté, deux tâches, mode
   `--member`, erreurs isolées. *Validé quand* deux profils Deezer de test donnent deux
   univers distincts et qu'un profil privé n'interrompt pas l'autre.
3. **Admin et arrivée (Deezer)** : invitation, accueil, suspension, suppression, suivi,
   « Synchroniser maintenant ». *Validé quand* les tests d'isolation passent tous.
4. **Spotify** : demande de place, écran admin Spotify, OAuth, jeton chiffré, lecture de la
   bibliothèque, rapprochement Deezer, changement de source. *Validé quand* le compte
   Spotify de l'admin (ou d'un testeur) produit un univers cohérent, que la révocation chez
   Spotify passe la source en `revoked` sans bloquer les autres, et que la 6e demande est
   refusée.
5. **Communauté v1** : ★ partagés, « j'y vais », propositions de salles.
6. **Phase de test** avec 2 ou 3 membres : mesures (section 8.3), réglage de Bandsintown et du
   poids `top_artist`.

**Tests d'isolation (automatisés, avant chaque mise en production)** :
- un membre A sur `/api/me/*` ne reçoit que ses données ;
- aucune route hors `/api/admin/*` n'accepte d'identifiant de membre ;
- `users/<B>/…` inaccessible à A, par URL directe comme par route ;
- un `state` OAuth créé pour A est refusé si B termine le retour Spotify ;
- membre suspendu : 403 avec une session Access valide ;
- après suppression : aucune ligne D1 ni objet R2 avec son identifiant, aucun jeton restant ;
- `/api/community/stars` ne renvoie jamais un ★ privé ni un ★ de membre suspendu ;
- `/api/admin/*` : 403 pour un membre ;
- `/api/admin/members` et `/api/admin/runs` ne contiennent ni nom d'artiste, ni identifiant
  de concert, ni jeton ;
- aucun jeton Spotify en clair dans D1, R2, les journaux ou les réponses d'API.

## 18. Points vérifiés et points à vérifier

Vérifiés le 12 octobre 2026 sur la documentation Spotify :
- propriétaire Premium obligatoire, 5 utilisateurs par application en mode développement
  (applications créées depuis le 11 février 2026), points d'accès supprimés, recherche
  limitée à 10 : guide de migration de février 2026 ;
- points d'accès encore disponibles (`/me/tracks`, `/me/albums`, `/me/following`,
  `/me/top/{type}`, `/me/playlists`, `/me`) : changelog de février 2026 ;
- quota compté par compte développeur, jusqu'à 25 applications par développeur, 429 avec
  `QUOTA_EXCEEDED` : changelog de juillet 2026 ;
- ajout manuel des utilisateurs (nom et e-mail du compte Spotify), 403 sinon : page « Quota
  modes » ;
- artistes similaires et recommandations fermés aux nouvelles applications : billet Spotify du
  27 novembre 2024.

À vérifier pendant le développement :
- `GET /playlists/{id}/items` en lecture en mode développement (ajouté en février 2026, statut
  de disponibilité non précisé) ;
- le compte propriétaire compte-t-il dans les 5 utilisateurs ;
- limites des offres gratuites Cloudflare (D1, R2, Access, Functions) pour l'usage prévu ;
- API Cloudflare : liste Zero Trust et révocation de sessions avec un jeton limité ;
- durée de session Access (proposition : 7 jours) ;
- comportement de l'API Deezer avec plusieurs profils lus à la suite.

## 19. Hors périmètre v1

OAuth Deezer, plusieurs sources par membre, envoi automatique des invitations par e-mail,
compteur de popularité, affinités entre membres, purge de l'historique git, contournement de
la limite Spotify par plusieurs applications.
