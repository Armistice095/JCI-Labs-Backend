// Vérifie la connexion à VOTRE compte FedaPay (sandbox) avec le même client que l'API.
//   npm run fedapay:check                      → crée une transaction de 100 XOF, affiche le lien de paiement, relit son statut
//   npm run fedapay:check -- --phone 0195789513 → teste l'envoi du téléphone (format à valider avec FedaPay)
//   npm run fedapay:check -- --wait             → attend (3 min max) que vous payiez avec un numéro de test, puis affiche le statut final
import 'dotenv/config';
import { loadEnv } from '../src/config/env';
import { FedaPayClient, toFedaPayLocalPhone } from '../src/sales/fedapay.client';
import { classifyStatus, mapMethod } from '../src/sales/fedapay-status';

async function main() {
  const env = loadEnv();
  const args = process.argv.slice(2);
  const phoneArg = args.includes('--phone') ? args[args.indexOf('--phone') + 1] : undefined;
  const client = new FedaPayClient(env);
  console.log(`Environnement : ${env.FEDAPAY_ENV}${env.FEDAPAY_API_BASE ? ` (base ${env.FEDAPAY_API_BASE})` : ''}`);

  const txn = await client.createTransaction({
    amountXof: 100,
    description: 'Test JCI Comé Labs (vérification)',
    callbackUrl: `${env.PUBLIC_WEB_URL}/commande/TEST?token=test`,
    customer: { firstname: 'Test', lastname: 'JCI', email: 'test@example.com', phoneLocal: phoneArg ? toFedaPayLocalPhone(`+229${phoneArg.replace(/^\+?229/, '')}`) : null },
    metadata: { order_reference: 'CMD-TEST', check: 'true' },
  });
  console.log('✔ Transaction créée :', txn);
  const tok = await client.generateToken(txn.id);
  console.log('✔ Lien de paiement  :', tok.url);
  const t = await client.getTransaction(txn.id);
  console.log('✔ Relecture         :', { status: t.status, kind: classifyStatus(t.status), amount: t.amount, mode: t.mode, metadata: t.metadata });

  if (args.includes('--wait')) {
    console.log('… Payez maintenant avec un numéro de test FedaPay (voir leur documentation sandbox).');
    const end = Date.now() + 180_000;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 4000));
      const cur = await client.getTransaction(txn.id);
      process.stdout.write(`  statut : ${cur.status}\r`);
      if (classifyStatus(cur.status) !== 'PENDING') {
        console.log('\n✔ Statut final      :', { status: cur.status, kind: classifyStatus(cur.status), mode: cur.mode, method: mapMethod(cur.mode), paidAt: cur.paidAt });
        return;
      }
    }
    console.log('\n⏱ Pas de paiement détecté dans le délai.');
  }
}
main().catch((e) => { console.error('✘', e.message ?? e); process.exit(1); });
