import { accentPalette, BRAND, escapeHtml as e, EVENT_CATEGORY_LABEL, fit, formatDateParts, formatTime, shortName } from './tokens';
import { DesignAssets } from './assets';
import { TicketRenderData } from './types';

const ico = (kind: 'cal' | 'clock' | 'pin', c: string) => ({
  cal: `<svg width="44" height="44" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="3" fill="${c}"/><rect x="7" y="2.5" width="2.2" height="5" rx="1.1" fill="#fff" stroke="${c}" stroke-width="1"/><rect x="14.8" y="2.5" width="2.2" height="5" rx="1.1" fill="#fff" stroke="${c}" stroke-width="1"/><rect x="6" y="12.5" width="3.4" height="3" rx=".8" fill="#fff"/><rect x="10.3" y="12.5" width="3.4" height="3" rx=".8" fill="#fff"/><rect x="14.6" y="12.5" width="3.4" height="3" rx=".8" fill="#fff"/></svg>`,
  clock: `<svg width="44" height="44" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.2" stroke="${c}" stroke-width="2.4"/><path d="M12 6.8V12l3.6 2.2" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pin: `<svg width="44" height="44" viewBox="0 0 24 24" fill="none"><path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12Z" fill="${c}"/><circle cx="12" cy="10" r="2.9" fill="#fff"/></svg>`,
}[kind]);

/**
 * Visuel de partage 1080 × 1920 (statut WhatsApp, story Facebook) : « J'y serai ! ».
 * Promotionnel : il ne contient JAMAIS le QR code ni le numéro du billet, et n'ouvre aucun accès.
 */
export function shareHtml(d: TicketRenderData, a: DesignAssets): string {
  const p = accentPalette(d.event.accentColor);
  const gold = `linear-gradient(90deg, ${p.dark} 0%, ${p.base} 22%, ${p.light} 52%, ${p.base} 78%, ${p.dark} 100%)`;
  const date = formatDateParts(d.event.startsAt);
  const time = formatTime(d.event.startsAt);
  const who = shortName(d.holderFirstName, d.holderLastName);
  const city = d.event.city.trim();
  const venue = (d.event.venueName.trim() || 'Lieu à confirmer') + (city && !d.event.venueName.toLowerCase().includes(city.toLowerCase()) ? `, ${city}` : '');
  const titleSize = fit(d.event.title, [[16, 78], [28, 66], [44, 54], [70, 44]], 36);
  const genTitleSize = fit(d.event.title, [[10, 130], [16, 108], [26, 88], [44, 68]], 52);
  const venueSize = fit(venue, [[28, 40], [48, 34]], 29);
  const label = EVENT_CATEGORY_LABEL[d.event.category] ?? 'Événement';
  const urlShort = (d.event.publicUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');

  const card = d.posterDataUri
    ? `<img class="poster" src="${d.posterDataUri}" alt="">`
    : `<div class="gen"><div class="bk k1"></div><div class="bk k2"></div><div class="bk k3"></div>
        <div class="gt" style="font-size:${genTitleSize}px">${e(d.event.title)}</div><div class="gl"><span>${e(label)}</span></div></div>`;

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>J'y serai</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<style>
${a.fontCss}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1920px;font-family:'Montserrat','Helvetica Neue',Arial,sans-serif;color:#fff;overflow:hidden;background:${BRAND.navyDeep}}
.bg{position:absolute;inset:0;background:radial-gradient(90% 55% at 50% 0%,#17428A 0%,${BRAND.navy} 45%,${BRAND.navyDeep} 100%)}
${d.posterDataUri ? `.blur{position:absolute;inset:-60px;background:url(${d.posterDataUri}) center/cover;filter:blur(46px) saturate(1.15);opacity:.5}.veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(6,18,48,.55),rgba(6,18,48,.82))}` : ''}
.logo{position:absolute;left:0;right:0;top:64px;margin:auto;width:250px;height:auto}
.card{position:absolute;left:100px;top:262px;width:880px;height:1030px;border-radius:48px;overflow:hidden;background:${BRAND.navy};border:6px solid ${p.base};box-shadow:0 30px 70px rgba(0,0,0,.5)}
.card .poster{width:100%;height:100%;object-fit:cover;object-position:center;display:block}
.gen{position:absolute;inset:0;background:radial-gradient(110% 80% at 20% 25%,#1C4C98 0%,${BRAND.navy} 48%,${BRAND.navyDeep} 100%)}
.bk{position:absolute;border-radius:50%;background:radial-gradient(circle,${p.light}CC 0%,${p.base}55 38%,${p.base}00 70%)}
.k1{left:620px;top:90px;width:190px;height:190px}.k2{left:50px;top:780px;width:230px;height:230px;opacity:.75}.k3{left:640px;top:700px;width:120px;height:120px;opacity:.6}
.gt{position:absolute;left:70px;right:70px;top:250px;font-weight:800;line-height:1.04;letter-spacing:-1px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.gl{position:absolute;left:70px;bottom:120px}.gl span{display:inline-block;padding:20px 52px;border-radius:60px;background:${gold};color:${p.onAccent};font-style:italic;font-weight:800;font-size:46px}
.banner{position:absolute;left:150px;top:1218px;width:780px;height:150px;background:${gold};clip-path:polygon(0 50%,44px 0,calc(100% - 44px) 0,100% 50%,calc(100% - 44px) 100%,44px 100%);display:flex;align-items:center;justify-content:center;color:${p.onAccent};font-style:italic;font-weight:800;font-size:98px;letter-spacing:-1px;filter:drop-shadow(0 12px 18px rgba(0,0,0,.45))}
.stack{position:absolute;left:70px;right:70px;top:1402px;display:flex;flex-direction:column;align-items:center;gap:20px}
.title{width:100%;text-align:center;font-weight:800;font-size:${titleSize}px;line-height:1.08;letter-spacing:-.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 3px 14px rgba(0,0,0,.4)}
.who{text-align:center;font-style:italic;font-weight:700;font-size:38px;color:${p.light}}
.row{display:flex;justify-content:center;align-items:center;gap:44px}
.it{display:flex;align-items:center;gap:14px;font-weight:700;font-size:38px;white-space:nowrap}
.it.v{font-size:${venueSize}px;white-space:normal;max-width:900px;line-height:1.1;text-transform:uppercase;font-weight:800}
.it svg{flex:none}
.sep{width:3px;height:54px;background:rgba(255,255,255,.28)}
.foot{position:absolute;left:0;right:0;bottom:56px;text-align:center}
.foot .cta{font-weight:700;font-size:32px;color:${p.light};margin-bottom:8px}
.foot .url{font-weight:600;font-size:30px;color:rgba(255,255,255,.78)}
</style></head><body>
<div class="bg"></div>${d.posterDataUri ? '<div class="blur"></div><div class="veil"></div>' : ''}
<img class="logo" src="${a.logoWhite}" alt="">
<div class="card">${card}</div>
<div class="banner">J’y serai !</div>
<div class="stack">
  <div class="title">${e(d.event.title)}</div>
  <div class="who">${e(who)}</div>
  <div class="row">
    <div class="it">${ico('cal', p.base)}<span>${e(date.day)} ${e(date.monthYear)}</span></div><div class="sep"></div>
    <div class="it">${ico('clock', p.base)}<span>${e(time)}</span></div>
  </div>
  <div class="row"><div class="it v">${ico('pin', p.base)}<span>${e(venue)}</span></div></div>
</div>
<div class="foot"><div class="cta">Rejoignez-moi !</div>${urlShort ? `<div class="url">${e(urlShort)}</div>` : ''}</div>
</body></html>`;
}
