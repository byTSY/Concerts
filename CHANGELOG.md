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
