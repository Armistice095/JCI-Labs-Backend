> Documentation technique du paiement. Retour au [README](../README.md).

# Paiements FedaPay

## Configuration (sandbox puis live)
1. Tableau de bord FedaPay → **Développeurs → Clés API** : copier la clé secrète dans `FEDAPAY_SECRET_KEY` et mettre `FEDAPAY_ENV=sandbox`.
2. **Webhooks → Créer** : URL `https://<votre-api>/api/v1/webhooks/fedapay`, cocher les événements `transaction.*` (approved, declined, canceled, transferred, updated…). Copier le **secret de signature** dans `FEDAPAY_WEBHOOK_SECRET`. En local, exposer l'API avec un tunnel (cloudflared, ngrok) ou utiliser `npm run fedapay:webhook`.
3. Passage en production : nouvelles clés, `FEDAPAY_ENV=live`, **nouveau webhook** (son secret est différent). Le démarrage échoue si la clé ne correspond pas à l'environnement.

## Tester avec votre compte FedaPay
```bash
npm run fedapay:check                       # crée une transaction de test (100 XOF), affiche le lien de paiement, relit son statut
npm run fedapay:check -- --phone 0195789513 # teste l'envoi du téléphone (format à valider)
npm run fedapay:check -- --wait             # attend que vous payiez avec un numéro de test et affiche le statut final
npm run fedapay:webhook -- <id_transaction> # envoie à l'API locale un webhook signé pour cette transaction
```
**Points à confirmer lors de ce premier test** (ils s'appuient sur la documentation et le SDK officiel, mais n'ont pas pu être exécutés contre FedaPay) :
- le format du téléphone envoyé (`phone_number.number` = numéro local à 10 chiffres, `country: "bj"`) ; si FedaPay le refuse, retirer `phoneLocal` dans `orders.service.ts` : la page de paiement le redemande de toute façon ;
- le contenu exact d'un webhook réel (le code n'utilise que le nom de l'événement et l'identifiant de transaction) ;
- le comportement de l'URL de retour (`callback_url`), à laquelle FedaPay ajoute ses propres paramètres.

## Ce qui garantit qu'un billet n'est émis que pour un vrai paiement
- Le **navigateur n'est jamais cru** : la page de retour ne fait qu'interroger notre API.
- Le **webhook n'est jamais cru non plus** : signature HMAC-SHA256 vérifiée en temps constant (+ tolérance 5 min, + IP optionnelle), puis un job **relit la transaction chez FedaPay** avec la clé secrète. Seuls `approved` / `transferred` valident ; tout statut inconnu = « en attente ».
- **Montant exact exigé** : un montant différent n'émet aucun billet et classe le paiement « à rembourser ».
- **Idempotence** à trois niveaux : événements dédoublonnés (clé unique), commande verrouillée en base pendant le traitement, un seul paiement `PAID` par commande (index unique).
- **Stock sans survente** : réservation par `UPDATE` atomique conditionnel ; 20 acheteurs simultanés pour 5 places = exactement 5 commandes (testé).
- **Webhook perdu ?** La page de retour et un balayage chaque minute revérifient les paiements en attente.

## Cas limites gérés
| Situation | Résultat |
|---|---|
| Paiement refusé / annulé | commande `FAILED`, places gardées jusqu'à expiration, l'acheteur peut réessayer (`retry-payment`) |
| Réessai alors que le paiement précédent est encore ouvert | on reprend la **même** transaction (pas de double débit) |
| Paiement après expiration de la réservation | on reprend les places si elles existent ; sinon commande `REFUND_REQUIRED` |
| Deuxième paiement d'une commande déjà payée | paiement `REFUND_REQUIRED` (doublon), un seul jeu de billets |
| Montant différent de celui attendu | paiement `REFUND_REQUIRED`, aucun billet |
| Remboursement fait dans le tableau de bord FedaPay | billets `REFUNDED` (refusés au scan), places remises en vente |
| FedaPay indisponible à l'achat | erreur 502 claire, places libérées immédiatement |

## Exploitation
- Les paiements/commandes `REFUND_REQUIRED` demandent une action humaine : filtrer `GET /events/{id}/orders?status=REFUND_REQUIRED` (écran Paiements) et rembourser depuis le tableau de bord FedaPay. Un remboursement complet fait là-bas est détecté tout seul.
- Réservation : 15 min par défaut (`app_settings.reservation_ttl_minutes`, bornée 5–60), plus 2 min de grâce avant libération.
- `PROCESS_ROLE` : `all` (API et tâches dans un seul processus : développement et Render gratuit) ou `api` + `worker` (deux services séparés, comme dans `docker-compose.yml`). pg-boss exige une connexion **directe** ou en mode **session** (`DIRECT_URL`) : jamais le pooler « transaction ».
- Limitation de débit en mémoire (1 instance). Avec plusieurs instances API, il faudra un stockage partagé.
- Turnstile est obligatoire en production (`TURNSTILE_SECRET_KEY`) ; la page d'achat doit envoyer `captchaToken` et un en-tête `Idempotency-Key` (UUID généré à l'ouverture du formulaire).
