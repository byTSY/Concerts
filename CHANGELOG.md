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

## 1.3.0 (13 octobre 2026)

Recherche sur tout le catalogue, statut « Places prises », section « Mes prochains concerts ».
- Barre de recherche en haut de l'app (site/search.js) : tous les concerts à venir publiés, sans
  tenir compte des filtres, concerts non recommandés compris (étiquette « Non recommandé ») ;
  artiste, titre et salle, sans accents ni majuscules, plusieurs mots ; une ligne par date ;
  60 résultats affichés au plus. Exécutée dans le navigateur sur events.json.
- Depuis un résultat : « Intéressé » ou « Places prises ».
- « J'y vais » renommé « Places prises » (statut going existant) ; « Y vont » devient « Ont leurs places ».
- « Mes prochains concerts » sous le cercle Reels : places prises à venir, du plus proche au plus lointain.
- L'ancien champ de recherche des filtres est retiré ; « Mes artistes » garde un filtre à lui.
Aucune migration D1.

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
