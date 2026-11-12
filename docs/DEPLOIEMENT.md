# Déploiement : premier déploiement sur Render (palier gratuit)

> Ce guide met en ligne l'API pour la **recette** (tests avec les équipes front et mobile, FedaPay en mode test). Il suppose un projet Supabase vierge. Retour au [README](../README.md).

**Ce que vous obtenez.** Une API publique en HTTPS (`https://jci-api.onrender.com`, puis `https://api.jcicomee.org`), qui se redéploie toute seule à chaque `git push`. L'API et les tâches de fond (e-mails, billets, webhooks) tournent dans un seul service.

**Ce que le palier gratuit impose** (à connaître avant de commencer) :

| Limite | Conséquence |
|---|---|
| Le service **s'endort après 15 min sans trafic** ; ~1 min pour se réveiller | La première requête après une pause est lente. Les tâches de fond sont aussi à l'arrêt pendant le sommeil. |
| **512 Mo de mémoire** | Node (~210 Mo) + Chromium pendant la génération d'un billet (~270 Mo en mode faible mémoire) : **ça passe de justesse**. À tester dès le premier déploiement (étape 6). |
| Pas de shell, disque éphémère, pas de `preDeployCommand` | Les **migrations se lancent depuis votre poste** (étape 2). Tous les fichiers sont dans Supabase Storage, rien n'est perdu au redémarrage. |
| Usage non destiné à la production (selon Render) | Parfait pour la recette ; pour la **vraie vente de billets**, passer à un hébergement qui reste allumé (voir « Passer en production »). |

---

## Étape 1 : préparer Supabase (une seule fois)

1. Créer le projet. **Choisir la région la plus proche de Render : Frankfurt (eu-central-1)**, pour que l'API et la base soient voisines. Noter le mot de passe de la base.
2. **Authentication → Sign In / Providers → désactiver « Allow new users to sign up »** : seuls les administrateurs créent des comptes (via l'API).
3. **Authentication → URL Configuration** : ajouter l'adresse de l'administration aux URL de redirection autorisées.
4. **Authentication → SMTP** : brancher Brevo en SMTP (invitations et réinitialisations de mot de passe). Sans cela, les envois par défaut de Supabase sont très limités.
5. **Storage** : créer deux buckets :
   - `event-posters` : **public** (affiches des événements) ;
   - `tickets` : **privé** (les billets contiennent des noms ; liens signés de 15 minutes).
6. **Récupérer les valeurs** (bouton **Connect** en haut du projet, et *Project Settings → API*) :

| Variable | Où la trouver | Remarque |
|---|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → clé `service_role` (ou « secret key » `sb_secret_…` sur les projets récents) | **SECRET** : jamais dans un front ni dans l'application mobile |
| `DATABASE_URL` | Connect → **Transaction pooler** (port **6543**) | à coller tel quel |
| `DIRECT_URL` | Connect → **Session pooler** (port **5432**) | même hôte `…pooler.supabase.com` |

> ⚠️ **Piège n°1 sur Render.** Render n'a pas d'IPv6 sortant, et l'adresse « Direct connection » (`db.xxxx.supabase.co`) n'est joignable qu'en IPv6 sur le plan gratuit. Si vous la mettez dans `DIRECT_URL`, l'API ne démarre pas (`ENETUNREACH`). Utilisez **toujours les deux adresses du pooler** (`aws-…pooler.supabase.com`).

## Étape 2 : créer les tables (depuis votre poste)

Le palier gratuit n'exécute pas de commande avant déploiement : les migrations se lancent à la main, **avant** le premier démarrage de l'API (et avant chaque déploiement qui ajoute une migration).

```bash
cp .env.example .env     # renseigner DATABASE_URL, DIRECT_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (les autres valeurs ne servent pas ici)
npm install
npx prisma migrate deploy                                    # crée les tables (DIRECT_URL, pooler « session »)
npm run db:sql                                               # contraintes, sécurité RLS, rôles et permissions (idempotent)
npm run bootstrap:admin -- admin@jcicomee.org Prénom Nom     # premier administrateur (un e-mail d'invitation est envoyé)
```

`npm run db:sql` doit être relancé après **chaque** migration Prisma : il réactive la sécurité RLS sur les nouvelles tables et échoue si l'une d'elles n'est pas protégée.

## Étape 3 : publier le code sur GitHub

```bash
git remote add origin https://github.com/<organisation>/<depot>.git
git push -u origin main
```

Le dépôt peut être **privé** : Render s'y connecte via son application GitHub. Vérifier avant le premier push qu'aucun `.env` n'est suivi : `git ls-files | grep -i "^\.env"` ne doit afficher que `.env.example`.

## Étape 4 : créer le service sur Render

1. [render.com](https://render.com) → **New → Blueprint** → autoriser GitHub → choisir le dépôt. Render lit `render.yaml` (service `jci-api`, plan **Free**, région **Frankfurt**).
2. Render demande la valeur des variables « secrètes ». Les remplir :

| Variable | Valeur |
|---|---|
| `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | étape 1 |
| `PUBLIC_WEB_URL` | adresse de la page publique (ex. `https://billets.jcicomee.org`) ; **sans `/` final**. Elle est écrite dans les QR codes des billets. |
| `ADMIN_WEB_URL` | adresse de l'administration (ex. `https://admin.jcicomee.org`) |
| `CORS_ORIGINS` | les deux adresses ci-dessus, séparées par une virgule, sans espace. **Sans cela, les navigateurs bloquent les appels.** |
| `ORG_CONTACT_PHONE` | WhatsApp de la JCI, format international (`+229…`) |
| `FEDAPAY_SECRET_KEY`, `FEDAPAY_WEBHOOK_SECRET` | FedaPay (sandbox) : voir [Paiements FedaPay](PAIEMENTS_FEDAPAY.md). Le secret du webhook n'existe qu'après l'étape 5 : mettre une valeur provisoire d'au moins 10 caractères, à corriger ensuite. |
| `TURNSTILE_SECRET_KEY` | **En recette**, la clé de test de Cloudflare `1x0000000000000000000000000000000AA` (accepte tout). La page publique utilise alors la clé de site de test `1x00000000000000000000AA`. En production : vraies clés. |
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` | Brevo (voir [Billets et e-mails](BILLETS_ET_EMAILS.md)) |
| `BREVO_WEBHOOK_TOKEN` | **généré par Render** : ne rien saisir |

   > En `NODE_ENV=production`, l'API **refuse de démarrer** si `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_WEBHOOK_TOKEN` ou `TURNSTILE_SECRET_KEY` manquent. C'est voulu : mieux vaut un échec visible qu'un site qui n'envoie aucun billet.

3. **Apply**. Le premier déploiement construit l'image Docker (Chromium inclus) : **compter 10 à 15 minutes**. Suivre l'avancement dans l'onglet *Logs*.
4. Quand Render affiche **Live**, ouvrir `https://<votre-service>.onrender.com/api/v1/health` : la réponse attendue est `{"status":"ok"}`.

## Étape 5 : brancher les services externes

- **Frontends et application mobile** : leur donner l'adresse `https://<votre-service>.onrender.com/api/v1` (variable `API_BASE_URL` / `PUBLIC_API_URL`), l'URL Supabase et la clé **anon** (jamais `service_role`).
- **Webhook FedaPay** : FedaPay → Webhooks → créer, URL `https://<votre-service>.onrender.com/api/v1/webhooks/fedapay`, événements `transaction.*`. Copier le **secret de signature** dans `FEDAPAY_WEBHOOK_SECRET` (Render → Environment → Save : redémarrage automatique).
- **Webhook Brevo** (peut attendre) : URL `https://<votre-service>.onrender.com/api/v1/webhooks/brevo`, authentification par jeton : copier la valeur de `BREVO_WEBHOOK_TOKEN` (Render → Environment) dans l'en-tête `Authorization: Bearer …`.
- **Domaine `api.jcicomee.org`** : Render → *Settings → Custom Domains* → ajouter `api.jcicomee.org`, puis créer chez le gestionnaire DNS (Cloudflare) un enregistrement **CNAME** `api` → `<votre-service>.onrender.com`, en mode « DNS seul » (nuage gris) le temps que le certificat soit émis. Mettre ensuite à jour les adresses chez FedaPay, Brevo et dans les frontends.

## Étape 6 : vérifier (liste de contrôle de recette)

1. `/api/v1/health` répond `ok`.
2. Connexion à l'administration avec le compte créé à l'étape 2.
3. Créer un événement avec une affiche, ajouter une catégorie, le publier.
4. Acheter un billet sur la page publique avec un numéro de test FedaPay (mode sandbox) : la commande passe à **payée**, l'e-mail arrive, le PDF se télécharge. **C'est le test de la mémoire** : s'il échoue, regarder les *Logs* Render à la recherche de `Out of memory` (voir « Dépannage »).
5. Scanner le billet avec JCI Stafs : « Entrée autorisée », puis « Déjà scanné ».
6. Laisser le service s'endormir 15 minutes, puis rouvrir la page publique : elle doit répondre après ~1 minute, et la file de tâches doit repartir toute seule.

---

## Exploitation au quotidien

- **Mettre à jour** : `git push` sur `main` → redéploiement automatique. Si la modification contient une **migration**, la lancer **avant** le push : `npx prisma migrate deploy && npm run db:sql`.
- **Voir les erreurs** : Render → *Logs*.
- **Changer une variable** : Render → *Environment* → *Save* (redémarrage automatique).
- **Garder le service éveillé** (facultatif, recette seulement) : un moniteur gratuit (UptimeRobot, toutes les 5 minutes) sur `/api/v1/health` évite le sommeil. Les 750 heures mensuelles couvrent un service allumé en permanence (744 h dans un mois de 31 jours), mais Render déconseille cet usage pour la production.
- **Supabase gratuit** : un projet sans activité pendant **une semaine** est mis en pause (base et authentification indisponibles) ; il se rétablit depuis le tableau de bord. Un service allumé en continu l'évite. Limites : 500 Mo de base, 1 Go de fichiers (affiches et billets), 5 Go de transfert par mois. Vérifier la politique de sauvegarde de votre plan et, sur le plan gratuit, prévoir un export régulier de la base.

## Passer en production (avant le premier vrai événement)

| À faire | Pourquoi |
|---|---|
| Quitter le palier gratuit de Render, **ou** héberger sur un serveur toujours allumé (voir ci-dessous) | Un service endormi ou à court de mémoire peut rater un paiement ou retarder les billets. |
| `FEDAPAY_ENV=live`, clés **live** et **nouveau webhook** (son secret est différent) | Le démarrage échoue si la clé ne correspond pas à l'environnement. |
| Vraies clés Cloudflare Turnstile | Les clés de test laissent passer tous les robots. |
| Domaine d'envoi Brevo authentifié (SPF, DKIM, DMARC) et webhook Brevo | Sans cela, les billets finissent en spam. Vérifier aussi le quota d'e-mails de votre plan Brevo. |
| `CHROMIUM_LOW_MEMORY=false` dès que l'hébergement dépasse 1 Go | Rendu plus rapide. |
| Un projet Supabase **dédié à la production** (plan adapté, sauvegardes) | Ne pas mélanger les données de recette et réelles. |

**Alternative : serveur toujours allumé (VPS, machine « Always Free » d'Oracle…).** Le dépôt contient `docker-compose.yml` (API, worker, Caddy pour le HTTPS automatique) et `Caddyfile` : remplacer `api.example.org` par le vrai domaine, créer le `.env`, puis `docker compose up -d --build`. Les migrations se lancent depuis le conteneur : `docker compose run --rm api npx prisma migrate deploy` puis `docker compose run --rm api npx tsx scripts/apply-sql.ts`. Sur un serveur de plus de 1 Go, séparer l'API et le worker (`PROCESS_ROLE=api` et `worker`, comme dans le fichier) est conseillé. *Le `Dockerfile` n'a pas pu être construit dans l'environnement de développement de cette étape (pas de démon Docker) : le premier build sur Render ou sur le serveur en est le vrai test.*

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Le déploiement échoue, journaux : `Configuration invalide : - XXX: …` | Variable d'environnement manquante ou mal formée | Render → Environment, corriger la variable citée |
| `ENETUNREACH` ou `ECONNREFUSED` vers la base | `DIRECT_URL` pointe vers `db.xxxx.supabase.co` (IPv6) | Utiliser les adresses du **pooler** (étape 1) |
| Migrations qui échouent ou file de tâches instable | `DIRECT_URL` utilise le pooler **transaction** (port 6543) | Mettre le pooler **session** (port 5432) |
| Déploiement « Live » puis `Out of memory (used over 512Mi)` pendant un achat | Chromium + Node dépassent 512 Mo | Vérifier `CHROMIUM_LOW_MEMORY=true` et `NODE_OPTIONS`. Si cela persiste : plan Render payant ou serveur plus grand. La tâche de rattrapage régénère les billets manquants chaque minute, rien n'est perdu. |
| Les appels du front échouent avec « CORS policy » | `CORS_ORIGINS` incomplet | Ajouter l'adresse exacte du front (schéma `https://`, sans `/` final) |
| Le front affiche « Connexion impossible » sans erreur CORS | Politique CSP du front (`connect-src`) qui n'autorise pas l'adresse de l'API | Corriger la CSP du front |
| Le webhook FedaPay répond 401 | `FEDAPAY_WEBHOOK_SECRET` ne correspond pas au secret du webhook | Recopier le secret de signature affiché par FedaPay |
| Première requête très lente le matin | Service endormi (palier gratuit) | Normal ; voir « Garder le service éveillé » |
| QR code des billets pointe vers `localhost` | `PUBLIC_WEB_URL` mal renseigné | Corriger (les billets déjà émis gardent l'ancienne adresse) |
