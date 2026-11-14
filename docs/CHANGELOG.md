# Journal des changements de l'API

Format : le plus récent en premier. « Cassant » = nécessite une adaptation des interfaces.

## 0.13.2 — aperçu des liens partagés (WhatsApp / Facebook) avec l'affiche

**Sans rupture, mais à répercuter dans la page publique de l'événement :**
- `og.imageUrl` pointe maintenant vers une **variante légère 1200 × 630 (JPEG, ≈ 50–200 Ko)** de l'affiche de couverture, créée à l'envoi de l'affiche (fond flou + affiche entière au centre). Avant, c'était l'original (jusqu'à 2 Mo) : WhatsApp ignore les images trop lourdes, d'où l'aperçu sans image.
- Nouveaux champs `og.imageWidth`, `og.imageHeight`, `og.imageType` : à mettre dans `og:image:width`, `og:image:height`, `og:image:type` (et garder `og:image` en URL absolue https).
- Si une affiche n'a pas de variante (envoyée avant cette version), `og.imageUrl` reste l'original.
- Base de données : colonne `event_posters.share_path` (migration `20261114090000_poster_share_image`). Lancer `npm run prisma:migrate`.
- **Affiches déjà envoyées** : `npm run posters:share` crée leurs variantes (relançable sans risque).
- Le slug d'un événement n'ajoute plus l'année si le titre la contient déjà (« … 2026 » ne donne plus `…-2026-2026`).
- **WhatsApp garde l'aperçu en cache par adresse** : pour un lien déjà partagé, utiliser le débogueur de partage de Facebook (« Scrape Again ») ou ajouter `?v=2` à l'adresse.

## 0.13.0 — billets sans Chromium, nouveau design, visuel de partage retiré

**Cassant (petit) — à répercuter dans les interfaces :**
- `GET /public/orders/{reference}` : le champ `tickets[].shareVisualUrl` **n'existe plus**. Retirer le bouton « Partager sur WhatsApp » qui l'utilisait (ou ne partager que l'adresse de la page).
- `GET /tickets/{ticketId}/files/{kind}` : `kind` = `pdf` ou `image` seulement ; `share` répond **422**.
- `filesReady` vaut `true` dès que le PDF **et** l'image existent (2 fichiers par billet, au lieu de 3).
- L'e-mail de confirmation ne joint plus que les PDF (plus de « Partage-….jpg »).

**Billets : beaucoup plus rapides.** Le PDF et le PNG ne passent plus par Chromium : un dessin SVG unique (texte converti en tracés) est converti en PNG par `resvg` et en PDF par `pdfkit`. Environ 0,25 s par billet au lieu de ~1,1 s (hors lancement de Chromium, qui ajoutait ~1,5 s au premier billet et après chaque période d'inactivité sur l'hébergement à mémoire serrée), moins de 50 Mo de mémoire en plus. **L'achat n'attend plus Chromium**, qui ne sert plus qu'aux 4 rapports PDF.

**Nouveau design du billet** (`TEMPLATE_VERSION` = 2) :
- plus de « Billet d'accès », de pastille de numéro ni de QR code dans le corps du billet (le QR code reste sur la souche) ;
- plus de logo au centre (il en reste un sur l'affiche et un sur la souche) ;
- affiche plus étroite, avec le **titre de l'événement écrit dessus** ;
- nom, date, heure et lieu disposent de toute la largeur centrale.

**Outil d'exploitation** : `npm run db:reset` (nettoyage des données de test avant la production : à blanc par défaut, confirmation de l'hôte, verrou contre une seconde exécution ; voir `docs/DEPLOIEMENT.md`).

**À savoir au déploiement :**
- Les billets déjà émis (version 1) ne sont plus servis : la tâche de rattrapage (chaque minute, commandes payées depuis moins de 7 jours, 30 par passage) les **régénère au nouveau design**, sans renvoyer d'e-mail. Les fichiers v1 restent en stockage ; l'ancienne valeur `SHARE_VISUAL` reste dans l'énumération de la base (aucune migration).
- Nouvelles dépendances : `@resvg/resvg-js` (binaire natif, aucune installation système), `pdfkit`, `svg-to-pdfkit`, `fontkit`. Rien à ajouter au Dockerfile.
- Les noms contenant des caractères absents de la police (emoji, alphabets non latins) sont affichés sans ces caractères.

## 0.12.0 — documents PDF de l'événement (onglet « Documents »)

**Nouvelles routes** (56 au total) — *additif, rien ne casse* :
- `GET /events/{eventId}/reports` : catalogue des 4 documents (`kind`, `title`, `description`, `formats: ["pdf"]`, `available`). `available` est `false` pour un événement en brouillon ou si le rôle n'a pas le droit.
- `GET /events/{eventId}/reports/{kind}` : télécharge le PDF. `kind` = `participants` (Liste des participants), `ticketing` (Rapport de billetterie), `attendance` (Liste des présences), `payments` (Journal des paiements). 20 appels/min/utilisateur, `Cache-Control: private, no-store`.
- Droits : `participants` → `participant.export` ; `attendance` → `checkin.view` ; `ticketing` et `payments` → `finance.view` ou `order.read`. Chaque téléchargement est tracé (`report.export`).
- Erreurs : 401, 403, 404, 409 (événement en brouillon), 422 (kind inconnu, ou plus de 3 000 lignes), 429.

**Notes d'exploitation** : aucune migration. Les PDF sont produits par le Chromium déjà utilisé pour les billets (Chrome ≥ 131 requis pour les en-têtes et pieds de page) ; polices Poppins ajoutées dans `assets/fonts/`. Sur Render gratuit, le premier PDF après une mise en veille peut prendre quelques secondes de plus.

## 0.11.0 — une seule section « Questions fréquentes »

**Comportement modifié** — *à adapter côté front* :
- `GET /public/events/{slug}` : `faq[]` commence maintenant par **3 éléments** « Infos pratiques », « Conditions d'utilisation du billet », « Annulation et remboursement » (texte de l'organisateur, sinon texte JCI), suivis des questions générales (6, ou 7 avec justificatif). **Le front supprime la section « Informations » à part** et affiche uniquement `faq` en un seul accordéon.
- `practicalInfo`, `ticketTerms`, `refundPolicy` et `infoSources` restent dans la réponse mais sont **dépréciés** (même contenu que les 3 premiers éléments de `faq`) : ne plus les afficher, sous peine de doublons. Ils seront retirés dans une version ultérieure, avec préavis ici.
- L'administration (`GET/PATCH /events/{id}`) ne change pas : l'organisateur continue de rédiger ces trois textes dans la fiche événement.

**Migration** : aucune.

## 0.10.0 — liste publique des événements, CORS de production

**Nouvelle route** (54 au total) — *additif, rien ne casse* :
- `GET /public/events?when=upcoming|past|all&page=&pageSize=` : événements publiés (cartes : `slug`, `title`, `category`, `accentColor`, dates, lieu, `coverUrl`, `salesStatus`, `priceFromXof`, `soldOut`, `updatedAt`), pour la page d'accueil de la billetterie et le `sitemap.xml`. Publique, 120 appels/min/IP, cache CDN 60 s.

**Modifié** :
- **Correctif CORS** : les méthodes `PUT`, `PATCH` et `DELETE` sont maintenant autorisées (seules `GET`, `HEAD` et `POST` l'étaient : le navigateur bloquait la modification, la publication et la suppression depuis `admin.jcicomee.org`, avec « Connexion impossible » côté front).
- Journaux : quand FedaPay refuse une requête, le début de sa réponse (300 caractères au plus) est ajouté à la ligne de journal, pour comprendre un 401/403/422. Rien n'est renvoyé au client.
- CORS : l'en-tête `Retry-After` est maintenant exposé aux navigateurs (lisible sur les réponses `429`). Les origines autorisées restent celles de `CORS_ORIGINS`.

**Configuration production** (aucun code) : `PUBLIC_WEB_URL=https://billets.jcicomee.org` (c'est aussi l'adresse de retour FedaPay et celle des QR codes), `ADMIN_WEB_URL=https://admin.jcicomee.org`, `CORS_ORIGINS` = les deux.

**Migration** : aucune.

## 0.9.0 — contrôle d'accès (application JCI Stafs)

**Nouvelles routes** (53 au total) — *additif, rien ne casse* :
- `POST /checkin/scan` : contrôle d'un billet à l'entrée (jeton du QR code ou numéro saisi). Six résultats en HTTP 200 : `ADMITTED`, `ALREADY_USED`, `WRONG_EVENT`, `CANCELLED`, `EVENT_NOT_ACTIVE`, `INVALID`. Admission **atomique** (un billet n'est admis qu'une fois, même en cas de scans simultanés), `Idempotency-Key` obligatoire (scan rejouable sans double comptage), journal de tous les scans. Permission `checkin.scan` sur l'événement.
- `GET /events/{eventId}/checkin/stats` : compteurs d'entrée (`checkin.view` ou `checkin.scan`).

**Migration** : `20261111100000_checkin_idempotency` (colonne `idempotency_key` unique sur `checkin_attempts`). À appliquer avec `npx prisma migrate deploy` (ou `migrate dev`), puis `npx prisma generate`.

**À noter** : la route publique `GET /public/tickets/{qrToken}` ne valide toujours rien ; seul `POST /checkin/scan` consomme un billet.

## 0.8.0 — tableau de bord

**Nouvelle route** (51 au total) — *additif, rien ne casse* :
- `GET /dashboard?range=7|30` : KPI (recettes, taux de remplissage, billets émis, événements), courbe des ventes jour par jour (jours à zéro compris, fuseau du Bénin), billets par catégorie tous événements confondus, 5 événements proches. Permission `dashboard.view` (**403** pour un vendeur ou un agent d'accueil) ; périmètre = événements visibles, brouillons exclus ; montants `null` sans `finance.view` / `order.read`.
- Les tableaux « Derniers paiements » et « Ventes physiques récentes » restent sur `GET /payments` et `GET /physical-sales` (inchangés).

**Annulé** : la route prévue `GET /dashboard/sales-series` n'existe pas ; la courbe est dans `GET /dashboard` (`sales`).

**Migration** : aucune.

## 0.7.0 — textes JCI par défaut et FAQ

**Comportement modifié** — *à adapter côté front* :
- `GET /public/events/{slug}` : `practicalInfo`, `ticketTerms`, `refundPolicy` ne sont **plus jamais `null`**. Si l'organisateur n'a rien rédigé, l'API renvoie le texte général JCI (avec les vraies valeurs : délai de réservation, maximum par commande, contact). Le front affiche donc toujours les 3 sections (la règle « masquer si `null` » de la 0.6.0 est supprimée). L'administration (`GET /events/{id}`) continue de renvoyer `null` pour un texte non rédigé.

**Champs ajoutés** — *additif* :
- `GET /public/events/{slug}` : `infoSources` (`event` ou `default` pour chacun des 3 textes) et `faq[]` (`question`, `answer`).
- `contactPhone` : numéro de l'événement, sinon celui de l'organisation ; `null` seulement si aucun n'est configuré.

**Configuration** : nouvelle variable facultative `ORG_CONTACT_PHONE` (ex. `+2290197000000`) dans `.env`. Redémarrer le backend.

**Migration** : aucune.

## 0.6.0 — page publique

**Champs ajoutés** — *additif, rien ne casse* :
- `GET /public/events/{slug}` : `category`, `accentColor`, `practicalInfo`, `ticketTerms`, `refundPolicy`. Le front n'affiche une section d'information que si son texte n'est pas `null`.
- `POST /events` et `PATCH /events/{id}` : `practicalInfo`, `ticketTerms`, `refundPolicy` (2 000 caractères maximum chacun ; une chaîne vide équivaut à `null`). Relus dans `GET /events/{id}`.

**Comportement** :
- `GET /public/events/{slug}` porte `Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=60` sur les réponses réussies uniquement (jamais sur un 404).
- Le `slug` d'un événement n'est jamais modifiable (déjà le cas ; désormais garanti par des tests).

**Migration** : `20261110220000_event_public_texts` (3 colonnes facultatives sur `events`). À appliquer avec `npx prisma migrate deploy`.

## 0.5.0 — vue d'ensemble

**Nouvelle route** (50 au total) — *additif, rien ne casse* :
- `GET /events/{eventId}/overview` : KPI (recettes, visiteurs, billets émis / capacité, places restantes), ventes par catégorie, 10 dernières activités. `revenueXof` (KPI et catégories) est `null` sans `finance.view` / `order.read` ; `activity` est `null` sans `participant.read`.

## 0.4.0 — participants

**Nouvelles routes** (49 au total) — *additif, rien ne casse* :
- `GET /events/{eventId}/participants` : liste paginée de l'onglet « Participants » (`q`, `categoryId`, `presence`, `sort`, `dir`) ; `meta.counts` pour les pastilles.
- `GET /events/{eventId}/participants/export` : export CSV ou Excel (`format=csv|xlsx`), mêmes filtres, 10 000 lignes maximum, journalisé.
- `GET /tickets/{ticketId}` : fiche d'un billet (« Voir le billet ») avec historique des e-mails.

**Comportement** : le statut de livraison des e-mails (`emailStatus`) est maintenant exposé ; les droits `participant.read` et `participant.export` sont actifs.

## 0.3.0 — billets, e-mails, visuel de partage

**Nouvelles routes** (46 au total) :
- `GET /tickets/{ticketId}/files/{kind}` (`pdf` | `image` | `share`) : URL signée de 15 min ; `202 { status: "PENDING" }` tant que le fichier n'est pas prêt.
- `POST /tickets/{ticketId}/resend` : renvoi du billet par e-mail (202 ; 5 par heure et par billet).
- `POST /webhooks/brevo` : *interne* (suivi de livraison des e-mails).

**Changement de `GET /public/orders/{reference}`** — *additif, rien ne casse* : chaque élément de `tickets[]` gagne `filesReady`, `pdfUrl`, `imageUrl`, `shareVisualUrl` (liens `null` tant que `filesReady` vaut `false`).

**Comportement** :
- Un e-mail de confirmation (PDF en pièces jointes) part automatiquement après un paiement confirmé, et après une vente physique si `buyer.email` est fourni et `sendEmail` n'est pas `false`.
- `PhysicalSaleCreate.sendEmail` : l'e-mail nécessite maintenant `buyer.email` ; les fichiers sont générés dans tous les cas.
- **Nouvelle route à exposer côté public : `/billet/:token`** (cible du QR code).

## 0.2.0 — premier contrat transmis à l'équipe frontend

**Contenu** : 43 routes en place (compte, utilisateurs et rôles, événements, affiches, billetterie, commandes et paiements, ventes physiques, annulation de billets, page publique, achat et suivi de commande).

**Par rapport à l'ébauche 0.1.0 (non diffusée)** — *cassant uniquement si vous aviez commencé à vous baser sur l'ébauche* :
- Retrait des routes **pas encore en place** : tableau de bord, vue d'ensemble, participants, présences, communication, exports, fichiers de billets, renvoi de billet, contrôle d'accès, webhook Brevo. Elles sont listées dans `GUIDE_FRONTEND.md` §9.
- Format OpenAPI 3.0.3 (au lieu de 3.1) pour une meilleure compatibilité des outils.
- `POST /tickets/{id}/cancel` renvoie `{ ticketId, status }` (et non un détail de billet).
- `OrderDetail.tickets[]` : champs `ticketId`, `ticketNumber`, `fullName`, `phone`, `email`, `category`, `ticketStatus`, `checkedInAt`.
- `PublicOrderStatus.tickets[]` : `number`, `holderName`, `category` (les liens de fichiers arrivent à l'étape billets).
- `PhysicalBuyer` : téléphone et e-mail facultatifs (obligatoires pour un achat en ligne).
- Nouveaux statuts `REFUND_REQUIRED` (commande et paiement), nouveau code d'erreur `PAYMENT_PROVIDER_ERROR`.

**Ajouts facultatifs** (rétrocompatibles) :
- `GET /events` : paramètres `sort` (`startsAt`, `-startsAt`, `createdAt`, `-createdAt` ; défaut `-startsAt`) et `upcoming=true` (widget « Événements proches »).
- `GET /events/{id}/orders`, `/payments`, `/physical-sales` : `status=PENDING` (alias « En attente » = `PENDING_PAYMENT` + `PAYMENT_IN_PROGRESS`) ; `meta.statusCounts.PENDING` pour la pastille.
