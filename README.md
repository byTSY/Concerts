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
3. Commande de build : laisser vide. Répertoire de sortie : `site`.
4. Cloudflare republie le site à chaque mise à jour du dépôt, donc chaque lundi.

L'adresse obtenue (`concerts-paris-xxx.pages.dev`) n'est référencée nulle part, mais reste
accessible à qui la connaît. Pour la réserver à votre adresse e-mail, activez Cloudflare
Access sur le projet (gratuit jusqu'à 50 utilisateurs).

## Réglages

`config/venues.yaml` : vos salles favorites. Elles sont signalées dans le site, filtrables
(« Vos salles uniquement ») et donnent un léger bonus aux découvertes. Pour une salle absente
des billetteries couvertes, renseignez `agenda_url` avec sa page programme : si la page
publie des données schema.org, ses concerts sont lus directement.

`config/hidden_artists.yaml` : artistes que vous ne voulez pas voir en concert. Leurs concerts
sortent de « Vos artistes » et des découvertes, et ils ne servent plus à calculer les
découvertes ; ils restent visibles dans « Tous les concerts » et dans l'onglet Mes artistes,
signalés « Masqué ». Un nom par ligne, tel qu'affiché dans Mes artistes (accents et majuscules
ignorés) ; un artiste hors de votre liste peut aussi y figurer pour ne plus être proposé en
découverte. Pour démasquer, supprimez la ligne.

```yaml
hidden:
  - Michel
  - Indochine
```

Modification depuis le site GitHub : ouvrez le fichier dans le dépôt, cliquez sur l'icône
crayon (Edit this file), ajoutez le nom, puis **Commit changes**. L'effet est visible au
prochain traitement (lundi), ou tout de suite en relançant le traitement depuis l'onglet Actions.

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
| Pages des salles | aucune | salles favorites dotées d'une `agenda_url` |

**L'Officiel des spectacles.** Le programme (https://www.offi.fr/concerts/programme.html) est
lu page par page, avec une pause de 3 secondes entre deux pages et un User-Agent qui renvoie
vers ce dépôt (c. 190 pages, c. 10 minutes). Une page refusée par le serveur est retentée
trois fois, puis ignorée. Seuls le titre, la salle, le genre, le prix, les dates et le lien
vers la fiche sont conservés ; une fiche à plusieurs dates donne un concert par date. Le prix
n'est affiché que pour les places vendues par offi.fr (c. 20 % des concerts).

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

**Découvertes.** Pour chaque artiste inconnu programmé à Paris, le script compare ses
« artistes similaires » Deezer à votre liste, et regarde aussi si vos artistes favoris le citent
parmi leurs similaires. La fiche indique de qui il est proche. Le script analyse 200 nouveaux
artistes par semaine au plus, en commençant par vos salles favorites ; le cache s'accumule,
la couverture s'élargit donc au fil des semaines.

**Votre liste ne fait que grandir.** Un artiste retiré de vos favoris reste suivi, signalé
« Retiré de vos favoris » dans l'onglet Mes artistes. Pour l'oublier, supprimez sa ligne dans
`data/artists.json`.

## Limites connues

- Homonymes : un nom courant (« Swing », « Barbara ») peut encore rattacher un concert d'un
  autre artiste quand il forme tout un segment du titre (« Sing and swing », « Barbara et
  moi »). À l'inverse, un artiste cité avec son prénom dans le titre (« Christophe Chassol »
  pour « Chassol ») n'est pas reconnu.
- Doublons : une salle désignée de deux façons sans mot commun (« Le Dôme de Paris » et
  « Palais des Sports ») ou un concert titré différemment par deux sources sans artiste
  reconnu peut encore apparaître deux fois dans « Tous les concerts ».
- Couverture : les concerts vendus uniquement par Fnac Spectacles, See Tickets, Dice ou
  Shotgun n'apparaissent que si la salle est configurée avec une `agenda_url` lisible.
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
