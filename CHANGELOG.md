# Journal des versions

Numérotation `MAJEUR.MINEUR.CORRECTIF` :
- MINEUR : une étape ou une fonctionnalité nouvelle (ex. 1.2.0) ;
- CORRECTIF : correction sans fonctionnalité nouvelle (ex. 1.1.1) ;
- MAJEUR : changement qui rompt l'existant (format des données, retour impossible sans intervention).

À chaque version : `VERSION`, la mention dans `site/index.html` (pied de page) et une entrée ici,
puis une étiquette git `vX.Y.Z` sur le commit publié.

Revenir à une version antérieure :
1. site : Cloudflare Pages, Deployments, « Rollback to this deployment » sur le déploiement voulu ;
2. code : `git revert` des commits concernés (ou nouvelle branche depuis l'étiquette `vX.Y.Z`) ;
3. base D1 : les migrations ne s'annulent pas seules ; chaque entrée indique la commande inverse
   quand une migration est ajoutée.

## 1.2.1 (13 octobre 2026)

Correctifs du calcul des membres.
- D1 (src/cloud.py) : une connexion neuve par requête (en-tête « Connection: close », plus de
  session partagée). Cause : un grand membre Spotify (lecture de la bibliothèque et rapprochement
  Deezer, c. 9 min sans requête D1) échouait en « internal » (ReadTimeout après 60 s) sur une
  connexion gardée ouverte que Cloudflare avait fermée. Nouvel essai automatique d'une lecture
  après une erreur réseau, une réponse tronquée ou une erreur passagère de Cloudflare (429, 5xx ;
  3 essais) ; d'une écriture, seulement si elle n'a pas pu partir (délai de connexion, connexion
  impossible), pour ne rien écrire en double.
- Relais côté site : à l'ouverture du site (GET /api/me), un calcul demandé depuis plus de
  15 minutes et resté sans résultat est relancé (dispatchRun), au plus une fois par 15 minutes et
  par membre, 3 fois au plus par demande, jamais le lundi de 5 h à 9 h UTC (un lancement
  remplacerait le traitement hebdomadaire en attente). Les tâches programmées de GitHub (relance
  des 2 heures, gardée en complément) peuvent être retardées ou abandonnées.
- Fin d'un calcul : last_sync_at reçoit l'heure de début du calcul ; une demande faite pendant le
  calcul (« Synchroniser maintenant », « Recalculer ») reste en attente au lieu d'être absorbée.
- Traitement lancé par le site (--member X --pending) : un membre déjà calculé entre-temps n'est
  pas recalculé (relais arrivé après la fin d'un calcul long).
- Migration D1 : 0007_sync_relay.sql (colonnes music_sources.sync_relayed_at et sync_relay_count),
  à appliquer en production avant le déploiement. Retour arrière :
  `ALTER TABLE music_sources DROP COLUMN sync_relayed_at; ALTER TABLE music_sources DROP COLUMN sync_relay_count; DELETE FROM schema_migrations WHERE name = '0007_sync_relay.sql';`

## 1.2.0 (13 octobre 2026)

Fiches Reels des nouveautés de la semaine, à la place du bandeau de billets.
- Cercle « Reels » dans l'en-tête (nombre de fiches à voir, anneau gris quand tout est vu) ;
  les fiches ne s'ouvrent qu'en le touchant.
- Fiche plein écran : photo Deezer, description Wikidata et artistes similaires (mêmes données que
  /partage/), date, salle, badge, mise en vente. Boutons Intéressé (= ★), Pas pour moi, Voir la fiche.
- Gestes : gauche, suivante ; droite, précédente ; bas, « Pas pour moi » (Ne plus recommander
  l'artiste, barre Annuler 6 s) ; seuil 45 px ou geste rapide ; toucher la photo à droite ou à
  gauche comme sur Instagram. Clavier : flèches. Couleurs propres aux fiches (lisibles en mode clair).
- Fiche vue dès son affichage, jamais réaffichée, sur tous les appareils : table D1 `seen_cards`,
  route GET/POST /api/me/seen (50 identifiants par appel, lignes de plus de 400 jours effacées).
- Migration D1 : 0006_seen_cards.sql. Retour arrière :
  `DROP TABLE seen_cards; DELETE FROM schema_migrations WHERE name = '0006_seen_cards.sql';`

## 1.1.0 (13 octobre 2026)

Présentation de l'organisateur (Dice) : correctif sur la fiche concert et la page /partage/.
- Cause retenue : un échec ponctuel de lecture de la page Dice (erreur, lenteur) était gardé en
  cache une semaine comme « pas de texte ». Désormais : rien en cache si la page n'a pas pu être
  lue, un jour si elle n'a pas de texte, une semaine sinon. Nouvelle clé de cache (« dice2 ») :
  les résultats vides de l'ancienne version sont abandonnés.
- Lecture plus tolérante : bloc JSON-LD en liste ou en @graph, aperçu og:description en secours,
  entités HTML décodées. Page /partage/ non gardée en cache quand le texte Dice manque.
- Délai de 4 s sur la page Dice, pour ne pas retarder la description de l'artiste ; délai de la
  fiche concert porté de 4 à 8 s (au-delà, la section « L'artiste » disparaissait en entier).
- Causes écartées : la fusion multi-sources conserve le lien Dice (vérifié sur les 255 concerts
  Dice fusionnés) ; la structure des pages Dice est inchangée au 13 octobre 2026.
- Numérotation des versions : VERSION, CHANGELOG.md, pied de page du site.
Aucune migration D1.

## 1.0.0 (13 octobre 2026)

Point de départ de la numérotation : état en production au commit `97edee0`.
Multi-membres (Deezer et Spotify), communauté (★ partagés, propositions de salles), invitation
par lien personnel. Migrations D1 appliquées : 0001 à 0005.
