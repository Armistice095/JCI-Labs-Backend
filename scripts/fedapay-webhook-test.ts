// Envoie à votre API locale un webhook correctement SIGNÉ pour une transaction donnée (simule FedaPay).
//   npm run fedapay:webhook -- <id_transaction> [transaction.approved] [http://localhost:3000]
// L'API relira la transaction chez FedaPay (sandbox) : le statut réel fait foi, pas le contenu de ce message.
import 'dotenv/config';
import { computeSignature } from '../src/sales/fedapay-signature';

async function main() {
  const [id, name = 'transaction.approved', base = 'http://localhost:3000'] = process.argv.slice(2);
  const secret = process.env.FEDAPAY_WEBHOOK_SECRET;
  if (!id || !secret) throw new Error('Usage : fedapay:webhook -- <id_transaction> [nom_événement] [url_api] (FEDAPAY_WEBHOOK_SECRET requis)');
  const raw = JSON.stringify({ id: Date.now(), object: 'event', name, entity: { id: Number(id), klass: 'v1/transaction' }, object_id: Number(id) });
  const t = Math.floor(Date.now() / 1000);
  const res = await fetch(`${base}/api/v1/webhooks/fedapay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fedapay-signature': `t=${t},s=${computeSignature(secret, t, raw)}` },
    body: raw,
  });
  console.log(res.status, await res.text());
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
