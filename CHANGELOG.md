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

## 1.7.0 (13 octobre 2026)

★ visibles par les autres membres par défaut.
- Nouveaux membres : réglage « visibles par les membres » à la création ; membres existants passés
  à ce réglage (migration 0009). Choix « masqués (visibles par vous seul) » dans « Mon compte », et
  case « Visible par les membres » à décocher sur la fiche d'un concert.
- Les ★ déjà posés gardent leur visibilité.
- Lien « Ajouter à mes Intéressés » de la newsletter : suit le réglage du membre ; le message
  indique la visibilité, avec « Annuler ».
- Migration D1 : 0009_visible_by_default.sql. Retour arrière : voir l'en-tête du fichier.

## 1.6.0 (13 octobre 2026)

Comprend les changements de 1.5.1 (non publiée seule).
- Catalogue : spectacles d'humour et de théâtre écartés (genres Ticketmaster « Comedy »,
  « Theatre », « Children's Theatre » ; 102 sur 5 105 le 13 octobre 2026), au prochain traitement.
- Fiche /partage/ ouverte depuis la newsletter (?app=1) : boutons « Ouvrir dans l'app » et
  « ★ Ajouter à mes Intéressés ». L'application ouvre la fiche du concert (?concert=<id>) et,
  pour le second, l'ajoute aux Intéressés s'il n'y est pas ; l'adresse est ensuite nettoyée.
  Une fiche partagée à quelqu'un d'autre (sans ?app=1) ne montre pas ces boutons. L'ajout par
  lien est toujours privé, avec « Annuler » (un lien venu d'ailleurs ne peut rien rendre visible).
- Revue complète du code, corrections :
  - workflow : relance de sécurité suspendue le lundi de 5 h à 9 h UTC (elle pouvait remplacer le
    traitement du lundi en attente) ; newsletter dans une tâche à part, envoyée même si la tâche
    membres échoue ou dépasse son délai (porté à 120 min) ; collecte publiée par la tâche membres
    seulement si elle l'a refaite ;
  - liens des sources (billetteries, écoute) limités à http(s) sur le site et la fiche /partage/ ;
    photo de la fiche encodée ; en-têtes de sécurité sur la page de désabonnement ;
  - newsletter : membre supprimé pendant l'envoi ignoré ; « Humour » écarté avec l'humour et le
    théâtre ; grandes salles lues une fois par traitement ; fiches Reels vues conservées pendant
    un envoi en cours ; textes « j'y vais » restants mis à jour.
Aucune migration D1.

## 1.5.1 (13 octobre 2026)

Newsletter : retours du premier essai.
- Style musical à la place de « Vos artistes, niveau X » (même règle que la fiche /partage/ :
  « Pop, Pop / Rock » donne « Pop », un lieu ou un instrument est sauté ; rien si la source n'en
  donne pas). Les découvertes gardent « Découverte, proche de … ».
- Secret SMTP_PORT : espaces tolérés ; valeur illisible : port 587, signalé dans le journal (le
  premier essai s'était arrêté sur une valeur mal saisie).
Aucune migration D1.

## 1.5.0 (13 octobre 2026)

Newsletter du lundi.
- À la fin du traitement programmé du lundi, un e-mail HTML par membre actif abonné : concerts de
  ses artistes annoncés cette semaine, recommandations des 30 jours suivants (ses artistes puis
  découvertes, 15 au plus), ses prochains concerts (« Places prises ») ; liens vers les fiches
  /partage/ et le site. Aucun envoi si les trois parties sont vides ; un envoi par semaine au plus.
- Envoi SMTP (src/newsletter.py, étape « Newsletter du lundi » de weekly.yml) : compte Gmail dédié
  avec mot de passe d'application, ou relais Brevo. Secrets GitHub SMTP_HOST, SMTP_PORT,
  SMTP_USER, SMTP_PASSWORD, NEWSLETTER_FROM ; sans eux, aucun envoi et le traitement continue.
- Essai : workflow « Newsletter (essai) » (newsletter-test.yml, bouton « Run workflow », champ
  member) : e-mail « [Essai] » à ce seul membre, sans collecte ni calcul, semaine non comptée ;
  groupe de concurrence à part, pour ne jamais remplacer le traitement du lundi en attente.
- Abonnement par défaut ; case « Newsletter du lundi » dans « Mon compte » ; lien de
  désabonnement dans chaque e-mail (page publique /partage/desabonnement/<jeton>, confirmation par
  un bouton) et désabonnement en un clic depuis la messagerie (List-Unsubscribe, RFC 8058).
- Audit : case « Mon compte » réellement enregistrée ; un envoi par semaine au plus même si le
  traitement est relancé ; newsletter envoyée même si un calcul de membre a échoué ; connexion SMTP
  impossible : envoi arrêté proprement, connexion perdue : un nouvel essai ; base sans la
  migration 0008 : aucun échec du traitement ni du site ; date du jour à Paris.
- Migration D1 : 0008_newsletter.sql (users.newsletter, newsletter_token, newsletter_sent_at),
  à appliquer en production avant le déploiement. Retour arrière : voir l'en-tête du fichier.

## 1.4.0 (13 octobre 2026)

Découvertes : grandes salles exclues.
- Liste dans config/venues.yaml (discovery_excluded) : Accor Arena, Zénith Paris La Villette,
  Paris La Défense Arena (libellée « Plenitude Arena » par les billetteries), Stade de France,
  avec leurs autres libellés. Adidas Arena gardée.
- Un concert dans ces salles n'est plus proposé en découverte (ni en fiche Reels). Les concerts
  de vos artistes y restent affichés, y compris un artiste repéré sous un autre libellé ; tous les
  concerts restent dans « Tous les concerts » et dans la recherche.
- Reconnaissance des salles par le comparateur existant (VenueMatcher) : 287 concerts reconnus
  dans le catalogue du 13 octobre 2026, aucun autre.
- Liste illisible ou entrée mal écrite : signalée dans le journal, aucun calcul arrêté.
- Pris en compte au calcul suivant de chaque membre (lundi, ou « Recalculer »).
Aucune migration D1.

## 1.3.0 (13 octobre 2026)

Recherche sur tout le catalogue, statut « Places prises », section « Mes prochains concerts ».
- Barre de recherche en haut de l'app (site/search.js) : tous les concerts à venir publiés, sans
  tenir compte des filtres, concerts non recommandés compris (étiquette « Non recommandé ») ;
  artiste, titre et salle, sans accents ni majuscules, plusieurs mots ; une ligne par date ;
  60 résultats affichés au plus. Exécutée dans le navigateur sur events.json.
- Depuis un résultat : « Intéressé » ou « Places prises » ; un clic sur l'autre statut passe de l'un
  à l'autre, un second clic sur le statut actif le retire (aussi sur la fiche concert).
- « J'y vais » renommé « Places prises » (statut going existant) ; « Y vont » devient « Ont leurs places ».
- « Mes prochains concerts » sous le cercle Reels : places prises à venir, du plus proche au plus lointain.
- L'ancien champ de recherche des filtres est retiré ; « Mes artistes » garde un filtre à lui.
Audit complet du code des versions 1.1.0 à 1.3.0, corrections :
- Reels : un toucher sur la fiche n'ouvre plus en plus la fiche concert de la carte suivante ;
  fiches vues relues au retour sur l'application et avant l'ouverture (liste illisible : pas
  d'ouverture) ; focus et flèches du clavier conservés ; bouton « ✓ Places prises » sur une fiche
  déjà en places prises ; « Annuler » proposé encore après la fermeture des fiches.
- ★ : enregistrements d'un même concert envoyés l'un après l'autre (clics rapprochés), affichage
  immédiat du statut avec retour en arrière en cas d'échec.
- Dice : page /partage/ sans cache seulement si la page Dice n'a pas été lue ; nouvel essai de la
  fiche concert si la présentation Dice manquait.
- Accessibilité : nom « Reels » du cercle lu, position des fiches et nombre de résultats annoncés.
Aucune migration D1.

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
