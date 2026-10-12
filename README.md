# Concerts à Paris

Chaque lundi matin, GitHub lit vos favoris Deezer, cherche les concerts à venir à Paris,
repère vos artistes et propose des découvertes proches de vos goûts. Le résultat est publié
sur un site privé : bandeau des nouveautés de la semaine, calendrier, liste, vos artistes, salles.

## Mise en place (c. 30 minutes, une seule fois)

### 1. Créer le dépôt GitHub

Créez un dépôt **privé** nommé `concerts-paris`, puis envoyez-y le contenu de ce dossier.
Sur Mac, le Finder masque le dossier `.github` : l'envoi par glisser-déposer sur le site GitHub
l'oublie. Passez plutôt par le Terminal :

```bash
cd chemin/vers/concerts-paris
git init -b main
git add .
git commit -m "Version initiale"
git remote add origin https://github.com/VOTRE-COMPTE/concerts-paris.git
git push -u origin main
```

(ou par l'application GitHub Desktop, qui envoie bien les dossiers masqués).

### 2. Obtenir une clé Ticketmaster (gratuite)

Créez un compte sur https://developer.ticketmaster.com, ouvrez « My Apps » et copiez la
« Consumer Key » (la première ligne du bloc Credentials ; le « Consumer Secret » n'est pas
utilisé). Dans le dépôt GitHub : **Settings > Secrets and variables > Actions >
New repository secret**, nom `TICKETMASTER_API_KEY`, valeur : la clé.

Sans cette clé, le site fonctionne avec les seules sources sans clé (Que faire à Paris,
L'Officiel des spectacles, pages des salles), donc sans aucune découverte : seul Ticketmaster
détaille la programmation artiste par artiste.

### 3. Bandsintown (facultatif)

Bandsintown délivre un identifiant d'application sur demande. Si vous en obtenez un,
ajoutez-le en secret sous le nom `BANDSINTOWN_APP_ID`. Il complète Ticketmaster pour les
petites salles et ajoute les premières parties aux découvertes.

### 4. Premier lancement

Onglet **Actions** du dépôt > « Mise à jour hebdomadaire » > **Run workflow**. Un passage
prend c. 15 minutes, dont c. 10 pour L'Officiel des spectacles (16 minutes mesurées le
7 octobre 2026) ; le premier est un peu plus long car il lit les artistes similaires de toute
votre liste. Le journal de l'exécution indique ce que chaque source a renvoyé.

Le traitement relance ensuite seul chaque lundi à 5h UTC.

### 5. Publier le site (Cloudflare Pages, gratuit, dépôt privé accepté)

1. Créez un compte sur https://dash.cloudflare.com.
2. Section Workers & Pages : créez une application Pages reliée à votre compte GitHub et
   choisissez le dépôt `concerts-paris` (l'intitulé exact des menus peut varier).
3. Commande de build : laisser vide. Répertoire de sortie (**Build output directory**) :
   `site`. Sans ce réglage, Cloudflare publie tout le dépôt et l'adresse du site renvoie
   « introuvable » (le site se retrouve sous `/site/`). Le réglage se modifie après coup dans
   Settings > Build > Build configuration, puis Deployments > **Retry deployment**.
4. Cloudflare republie le site à chaque mise à jour du dépôt, donc chaque lundi.

L'adresse obtenue (`concerts-paris-xxx.pages.dev`) n'est référencée nulle part, mais reste
accessible à qui la connaît. Pour la réserver à votre adresse e-mail, activez Cloudflare
Access sur le projet (gratuit jusqu'à 50 utilisateurs).

## Version multi-membres (en cours, spécification `SPEC.md`)

Le site s'ouvre à un petit groupe de membres, chacun avec son propre univers. Les données
personnelles quittent GitHub pour Cloudflare :

| Où | Quoi |
|---|---|
| Dépôt (`site/data/`, `data/concerts.json`, `data/cache/`) | données communes : tous les concerts, sans aucun champ personnel ; salles observées ; caches Deezer |
| Cloudflare D1 (base SQL) | membres, source musicale, préférences (masqués, niveaux), salles favorites, ★, catalogue des salles |
| Cloudflare R2 (`users/<id>/`) | résultats calculés par membre : `artists.json`, `overlay.json` (ce que chaque concert est pour lui), `history.json`, `meta.json` |

Le site charge les concerts communs en statique, puis les données du membre connecté par
`/api/me/*`. Le membre est reconnu par son jeton Cloudflare Access, vérifié par
`functions/api/_middleware.js` ; seul `functions/_lib/me.js` lit ou écrit ses données
(côté traitement : `src/members.py`).

### Mise à jour du schéma de la base

```powershell
.venv\Scripts\python -m src.migrate schema
```

Avec les variables `CF_ACCOUNT_ID`, `D1_DATABASE_ID` et `CF_D1_API_TOKEN`, la commande travaille
sur Cloudflare ; `--local` la fait travailler sur la copie locale (`data/local/`, non
versionnée). Le traitement utilise aussi cette copie locale quand les variables Cloudflare
manquent, sauf dans GitHub Actions où un secret manquant l'arrête.

Réglages Cloudflare du projet Pages (Settings > Bindings, et Variables and Secrets) :

| Nom | Type | Valeur |
|---|---|---|
| `DB` | liaison D1 | base `concerts` (production), `concerts-preview` (prévisualisation) |
| `BUCKET` | liaison R2 | compartiment `concerts-membres` (production), `concerts-membres-preview` |
| `ACCESS_TEAM_DOMAIN` | variable | `<équipe>.cloudflareaccess.com` |
| `ACCESS_AUD` | variable | « Application Audience (AUD) Tag » de l'application Access du site (plusieurs valeurs séparées par des virgules) |

Secrets GitHub Actions : les six variables Cloudflare ci-dessus.

Tests (avant chaque mise en production) :

```powershell
.venv\Scripts\python -m unittest discover -s tests -t .   # historique : non-régression
node --test tests/functions.test.mjs                     # jeton Access, barrière, isolation entre membres
```

Limites des offres gratuites (documentation Cloudflare, 12 octobre 2026) : D1, 5 millions de
lignes lues et 100 000 écrites par jour, 5 Go ; R2, 10 Go, 1 million d'écritures et
10 millions de lectures par mois ; Functions, 100 000 requêtes par jour et 10 ms de calcul par
requête (les fichiers R2 sont donc renvoyés sans être relus).

## Réglages

Préférences, ★ et salles favorites de chaque membre : depuis le site, enregistrés dans D1.

- **Masquer un artiste** que vous ne voulez pas voir en concert : ses concerts sortent de
  « Vos artistes » et des découvertes, et il ne sert plus à calculer les découvertes ; ses
  concerts restent dans « Tous les concerts ». Un artiste hors de votre liste peut aussi être
  masqué, pour ne plus être proposé en découverte (fiche du concert, « Ne plus recommander »).
- **Imposer un niveau** (1, 2 ou 3) à la place du niveau calculé à partir de vos likes
  (onglet Mes artistes ; « Calculé » pour revenir au niveau issu de vos likes). Le niveau
  imposé compte aussi dans le calcul des découvertes, au traitement suivant.

Catalogue des salles : table `venues` de D1 (nom, alias selon les billetteries, page programme
`agenda_url` lue quand elle publie des données schema.org, exclusion).

`config/settings.yaml` : zone, horizon, barème du score, découvertes, plafonds de stockage R2.

## Le site

- **Calendrier** et **Liste** : vos artistes et les découvertes, ou tous les concerts.
  Filtres : vos salles, style, recherche.
- **Par artiste** : vos artistes qui ont au moins un concert à venir, avec la date et la salle
  du prochain et les dates suivantes. Tri par date du prochain concert, par nom, ou par date
  d'ajout sur Deezer (le like le plus récent : artiste, album, titre ou ajout en playlist).
- **★ Intéressés** : les concerts mis de côté pour acheter les places plus tard (étoile dans
  la liste ou « ☆ Mettre de côté » sur la fiche d'un concert), du plus proche au plus lointain,
  avec la date de mise en vente quand elle est connue et un lien par billetterie. La liste est
  enregistrée dans D1, donc commune à tous vos appareils ; les concerts passés y sont
  signalés et peuvent être retirés.
- **Mes artistes** : toute votre liste, classée par niveau puis par score, avec le détail du
  score et les préférences (masquer, niveau imposé).
- **Salles** : vos salles favorites et celles où passent des artistes pour vous.

**Partager un concert** : bouton « Partager » sur la fiche d'un concert. Il ouvre le menu de
partage du téléphone (WhatsApp, Messages…) avec un message prêt à envoyer, par exemple :

> Hey, il y a le concert de Temples le samedi 17 octobre à 20h, au Trianon.
> C'est du rock psychédélique. Groupe de rock anglais, dans la veine de Pond, Future Islands et
> King Gizzard & The Lizard Wizard.
> On prend des places ?
>
> https://concerts-s2k.pages.dev/partage/…

Sur ordinateur, le message est copié dans le presse-papiers. Le lien mène à une page publique
`/partage/<concert>` : photo de l'artiste, date, salle, prix, genres, description, liens
d'achat, Deezer, Spotify et YouTube, avec un aperçu dans WhatsApp et Messages. Cette page ne
montre que le concert partagé, rien de votre liste ni de vos préférences.

Description de l'artiste, en français et centrée sur la musique :
- **Wikidata** : description courte (« groupe de rock anglais », « pionnier de la musique techno
  de Detroit ») et genres musicaux. Parmi les homonymes, seule une fiche liée à la musique est
  retenue (identifiant Deezer, Discogs, MusicBrainz ou Spotify, ou genre musical) ; si elle
  porte l'identifiant Deezer de l'artiste, le rapprochement est certain. Sans description en
  français, elle est composée à partir du métier et du pays (« chanteuse américaine »).
- **Deezer** : photo et trois artistes similaires (« dans la veine de… »), y compris pour les
  artistes absents de Wikidata.

Liens d'écoute et d'achat :
- **Spotify** : page exacte de l'artiste, grâce à son identifiant Spotify dans Wikidata (c. 55 %
  de vos artistes) ; à défaut, via l'API Spotify si elle est configurée (voir ci-dessous) ;
  sinon, recherche sur le nom.
- **YouTube** : recherche sur le nom de l'artiste.
- **Billets** : un bouton par billetterie connue (Ticketmaster, Dice, Offi, Que faire à Paris),
  plus « Chercher sur Fnac Spectacles », qui ouvre la recherche sur l'artiste : Fnac Spectacles
  bloque la lecture automatique de son site, on ne peut donc pas savoir à l'avance si le
  concert y est en vente.
- **Présentation** : pour un concert vendu sur Dice, le texte de l'organisateur est repris sur la
  fiche web et dans la fiche du concert.

Résultats mis en cache une semaine. Fonction : `functions/partage/[[path]].js`.

**API Spotify (facultatif, liens exacts pour tous les artistes).** Sur
https://developer.spotify.com/dashboard, créez une application (nom `Concerts`, Redirect URI
`https://concerts-s2k.pages.dev`, API : *Web API*), puis copiez son *Client ID* et son *Client
Secret*. Dans Cloudflare, projet `concerts` > Settings > Variables and Secrets, ajoutez deux
secrets : `SPOTIFY_CLIENT_ID` et `SPOTIFY_CLIENT_SECRET`, puis **Retry deployment**.

**Rendre les fiches accessibles à vos amis (une seule fois).** Le site étant réservé à votre
adresse e-mail, il faut ouvrir le seul chemin `/partage/` : Zero Trust > Access >
Applications > **Create new application** > *Self-hosted* ; nom `Concerts partage` ;
destination (saisie libre, *Switch to custom input*) `concerts-s2k.pages.dev/partage` ; policy
*Bypass* avec *Include* > *Everyone* (à défaut : *IP ranges* `0.0.0.0/0` et `::/0`).
Cloudflare applique la règle la plus précise : `/partage/…` devient public, le reste du site
reste protégé.

**Styles.** Les genres des sources (Ticketmaster en anglais, L'Officiel des spectacles en
français, rien pour Que faire à Paris) sont regroupés en familles : jazz, blues, soul ; rap,
R&B ; pop, rock, folk ; électro ; metal ; chanson française ; musiques du monde ; classique,
opéra ; ciné-concerts, humour, jeune public. Un concert peut relever de plusieurs familles ;
c. 20 % n'ont pas de genre renseigné (« Style non renseigné »).

`config/settings.yaml` : identifiant Deezer, rayon autour de Paris, pondérations du score
d'affinité, seuil des découvertes.

Après modification, relancez le traitement depuis l'onglet Actions pour voir l'effet tout de suite.

## Sources

| Source | Clé | Contenu |
|---|---|---|
| Ticketmaster (Discovery API) | `TICKETMASTER_API_KEY` | concerts dans un rayon de 12 km, avec la liste des artistes ; pas de prix pour la France |
| Bandsintown | `BANDSINTOWN_APP_ID`, facultatif | concerts de vos artistes, premières parties |
| Que faire à Paris (open data de la Ville) | aucune | concerts annoncés par la Ville, souvent gratuits |
| L'Officiel des spectacles (offi.fr) | aucune | programme des concerts de Paris et d'Île-de-France |
| Dice (dice.fm) | aucune | concerts et soirées vendus sur Dice, salle par salle |
| Pages des salles | aucune | salles favorites dotées d'une `agenda_url` |

**L'Officiel des spectacles.** Le programme (https://www.offi.fr/concerts/programme.html) est
lu page par page, avec une pause de 3 secondes entre deux pages et un User-Agent qui renvoie
vers ce dépôt (c. 190 pages, c. 10 minutes). Une page refusée par le serveur est retentée
trois fois, puis ignorée. Seuls le titre, la salle, le genre, le prix, les dates et le lien
vers la fiche sont conservés ; une fiche à plusieurs dates donne un concert par date. Le prix
n'est affiché que pour les places vendues par offi.fr (c. 20 % des concerts).

**Dice.** Seules les pages publiques sont lues (le robots.txt de Dice n'interdit que son API
interne), avec la même pause de 3 secondes et le même User-Agent. Les pages « Paris » (concerts,
soirées, DJ) révèlent les salles actives sur Dice ; la page de chaque salle donne ensuite ses
concerts à venir. La liste des salles est conservée dans `data/cache/dice_venues.json` et
s'enrichit chaque semaine (61 salles au départ, c. 3 minutes de lecture). Limite : la page d'une
salle n'affiche que ses 30 prochains concerts ; pour les salles très actives (Supersonic, Petit
Bain…), un concert n'apparaît donc que c. trois semaines avant sa date.

Un même concert vu par plusieurs sources n'apparaît qu'une fois, avec un lien par source.
Deux fiches sont fusionnées quand elles ont la même date, le même artiste ou le même titre, et
une même salle. Les libellés de salle diffèrent souvent d'une source à l'autre (« LE TRABENDO
(Parc de la Villette) » et « Le Trabendo », « SUPERSONIC » et « Supersonic Club ») : ils sont
considérés comme une même salle quand l'un contient l'autre ou qu'ils partagent un mot
distinctif (les mots comme salle, théâtre, église ou saint ne comptent pas). Deux fiches dont
les horaires diffèrent de plus d'une heure restent séparées.

## Nouveautés et base des concerts

`data/concerts.json` conserve tous les concerts à venir, qu'ils concernent ou non vos
artistes, avec leur date d'apparition (`first_seen`). Chaque concert y garde le même
identifiant d'une semaine à l'autre, retrouvé grâce aux identifiants de ses sources.

**Premier passage.** Tous les concerts forment la base initiale : aucun badge, le bandeau
l'indique.

**Passages suivants.** Deux badges distincts, affichés pendant 7 jours :

- **Nouvelle annonce** : concert absent de la base la semaine précédente.
- **Nouveau dans votre liste** : concert déjà connu qui entre dans votre liste, parce que vous
  avez liké l'artiste sur Deezer ou qu'il devient une découverte.

Le bandeau ne présente que les nouveautés de votre liste (vos artistes et découvertes). Le
filtre **Tous les concerts** affiche l'ensemble de la base, y compris les concerts sans lien
avec vos goûts, avec les mêmes badges.

Les concerts passés sont retirés de la base. Un concert à venir absent des sources une
semaine (source en panne, fiche retirée) y reste, pour ne pas revenir ensuite comme une
nouvelle annonce. Pour repartir d'une base initiale, supprimez `data/concerts.json`.

## Comment les concerts sont retenus

**Vos artistes.** Chaque artiste reçoit un score : 5 points s'il est en favori, 2 par album
liké, 1 par titre liké, 0,25 par titre présent dans vos playlists. Niveau 1 à partir de 5
points, niveau 2 à partir de 2, niveau 3 en dessous. Un concert est retenu quand le nom d'un
de vos artistes figure dans la programmation, ou, pour les sources sans programmation
détaillée (Que faire à Paris, L'Officiel des spectacles), dans le titre, repéré « à vérifier »
sur la fiche. Le rapprochement sur le titre suit trois règles :

- un hommage ou une reprise ne compte pas (« Tribute to David Bowie », « The Music of Queen »,
  « X joue Christophe », « The Dire Straits Experience ») ;
- un nom d'un seul mot doit former à lui seul un segment du titre, une fois retirés les mots
  comme trio, live band ou en concert : « NISKA » et « Avishai Cohen trio » sont retenus,
  « Michel Alibo » ne l'est pas pour l'artiste « Michel » ;
- un nom de plusieurs mots est retenu n'importe où dans le titre.

**Découvertes.** Pour chaque artiste inconnu programmé à Paris (artistes fournis par la
source ou, pour L'Officiel des spectacles, nom tiré du titre de la fiche : « Guinga et Yamandu
Costa » donne deux artistes, un hommage n'en donne aucun), le script compare ses
« artistes similaires » Deezer à votre liste, et regarde aussi si vos artistes favoris le citent
parmi leurs similaires. La fiche indique de qui il est proche. Le script analyse 400 nouveaux
artistes par semaine au plus, en commençant par vos salles favorites ; le cache s'accumule,
la couverture s'élargit donc au fil des semaines.

**Votre liste ne fait que grandir.** Un artiste retiré de vos favoris reste suivi, signalé
« Retiré de vos favoris » dans l'onglet Mes artistes. Pour ne plus le voir en concert, masquez-le.

## Limites connues

- Homonymes : un nom courant (« Swing », « Barbara ») peut encore rattacher un concert d'un
  autre artiste quand il forme tout un segment du titre (« Sing and swing », « Barbara et
  moi »). À l'inverse, un artiste cité avec son prénom dans le titre (« Christophe Chassol »
  pour « Chassol ») n'est pas reconnu.
- Doublons : une salle désignée de deux façons sans mot commun (« Le Dôme de Paris » et
  « Palais des Sports ») ou un concert titré différemment par deux sources sans artiste
  reconnu peut encore apparaître deux fois dans « Tous les concerts ».
- Couverture : les concerts vendus uniquement par Fnac Spectacles, See Tickets ou Shotgun
  n'apparaissent que si la salle est configurée avec une `agenda_url` lisible (Fnac Spectacles
  bloque la lecture automatique).
- Les sites de salles changent de structure sans prévenir : une salle qui ne renvoie plus
  rien apparaît avec 0 événement dans le journal du traitement.

## Tester sur votre ordinateur

Sur Mac ou Linux :

```bash
pip install -r requirements.txt
export TICKETMASTER_API_KEY=votre_cle
python -m src.main
python -m http.server 8000 -d site    # puis ouvrir http://localhost:8000
```

Sous Windows (PowerShell), avec la clé enregistrée une fois pour toutes dans les variables
d'environnement de l'utilisateur :

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
[Environment]::SetEnvironmentVariable('TICKETMASTER_API_KEY', 'votre_cle', 'User')   # puis rouvrir le terminal
.venv\Scripts\python -m src.main
.venv\Scripts\python -m http.server 8000 -d site
```
