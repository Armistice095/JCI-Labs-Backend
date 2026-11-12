> Documentation technique des billets et des e-mails. Retour au [README](../README.md).

# Billets et e-mails

## Le design
Le billet reprend la maquette de la JCI : artwork de l'événement (à gauche), informations + QR code (au centre), souche détachable (à droite). Même HTML → **PDF** (297 × 99,5 mm, texte et QR vectoriels, pour l'impression) et **PNG** 2244 × 752 (pour le téléphone). Le **visuel de partage** (« J'y serai ! », 1080 × 1920 JPEG) est un gabarit distinct : il ne contient jamais le QR code, le numéro de billet ni le nom complet.
- Affiche de l'événement = panneau de gauche ; sans affiche, un artwork aux couleurs de la JCI avec le titre. La couleur d'accent de l'événement (`accentColor`) remplace l'or par défaut.
- Aperçu sans base de données : `npm run ticket:preview` (écrit dans `./preview/`) ; options : `-- --poster affiche.jpg --accent "#E9B63B" --title "…" --venue "…" --category "Pass soutien" --price 10000`.
- Fichiers : `src/tickets/design/` (tokens, ticket-html, share-html). La version du gabarit (`TEMPLATE_VERSION`) permet de faire évoluer le design sans toucher aux billets déjà émis.
- Le QR encode `{PUBLIC_WEB_URL}/billet/{jeton}` (jeton aléatoire de 128 bits, aucune donnée personnelle). **L'interface publique doit exposer la route `/billet/:token`** (elle appelle `GET /public/tickets/{token}`). Lisibilité vérifiée : relu depuis le PNG, le PDF imprimé et une image compressée type WhatsApp.

## Prérequis
1. **Chromium ou Chrome** sur la machine qui exécute le worker. Détecté automatiquement (Linux, Windows : Chrome ou Edge, macOS) ; sinon `CHROMIUM_PATH`. L'image Docker l'installe. Sur un hébergement de 512 Mo, activer `CHROMIUM_LOW_MEMORY=true` : Chromium tourne en un seul processus, un rendu à la fois, et s'éteint après 20 s d'inactivité (pic mesuré : ~270 Mo au lieu de ~360 Mo, billets strictement identiques).
2. **Supabase Storage** : créer un bucket **privé** `tickets` (les billets contiennent des noms : jamais public). Les liens de téléchargement sont des URL signées de 15 minutes.
3. **Brevo** :
   - authentifier le **domaine d'envoi** (SPF, DKIM, DMARC) et vérifier l'expéditeur : sans cela, les billets finiront en spam ;
   - créer une clé API (`BREVO_API_KEY`). *Piège classique* : si la clé a une liste d'**IP autorisées** dans Brevo, l'API répond 401 depuis une IP non listée (votre poste, un nouveau serveur) ;
   - **webhooks** (Brevo → Webhooks → Transactionnel) : URL `https://<votre-api>/api/v1/webhooks/brevo`, événements : envoyé, délivré, rebond (soft/hard), bloqué, spam, différé. Les webhooks Brevo **ne sont pas signés** : configurez l'authentification par jeton (`Authorization: Bearer <BREVO_WEBHOOK_TOKEN>`) et, si possible, la liste d'IP.
   - **Quota** : le plan gratuit de Brevo est limité (de l'ordre de 300 e-mails/jour au moment de la rédaction ; à vérifier chez Brevo). Un événement qui vend plusieurs centaines de billets en une journée peut le dépasser : prévoir un plan payant avant le lancement.

## Fonctionnement
- Paiement confirmé (ou vente physique) → job `order.fulfilled` → génération des 3 fichiers de chaque billet (stockage privé, table `generated_files`) → e-mail de confirmation (PDF joints + visuel de partage du premier billet + lien « Mes billets »). Au-delà de 8 Mo de pièces jointes (limite Brevo : 20 Mo), l'e-mail ne contient que des liens.
- **Rien ne se perd** : chaque étape est idempotente et rejouée avec attente croissante ; une tâche de maintenance (chaque minute) relance les commandes payées dont les fichiers manquent ou dont l'e-mail n'est pas parti. L'e-mail de confirmation n'est jamais envoyé deux fois (verrou + journal `email_logs`) ; garantie « au moins une fois » si Brevo accepte puis que la base échoue.
- Suivi de livraison : les webhooks Brevo mettent à jour `email_logs` (envoyé, délivré, rebond, spam…), sans jamais faire reculer un statut.
- Vente physique : les fichiers sont toujours générés (`GET /tickets/{id}/files/{kind}` pour remettre le billet) ; l'e-mail part seulement si une adresse est fournie et `sendEmail` est vrai.
- Renvoi : `POST /tickets/{id}/resend` (5 par heure et par billet).
- Sécurité du rendu : tout texte est échappé, le HTML est rendu sans script avec une politique `default-src 'none'`, et toute requête réseau est bloquée pendant le rendu.

## Points à valider avec la JCI
- **Format du numéro de billet** : la maquette affiche `JCI-CE-2026-0001`, le système génère `JCI-2026-000001` (format du cahier des charges et des maquettes d'administration). Changement en une ligne si besoin.
- Texte « Présentez ce billet à l'entrée… » : repris tel quel de la maquette.
