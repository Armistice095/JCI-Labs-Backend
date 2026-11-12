import { accentPalette, BRAND, escapeHtml as e, EVENT_CATEGORY_LABEL, fit, formatDateParts, formatPrice, formatTime } from './tokens';
import { DesignAssets } from './assets';
import { TicketRenderData } from './types';

const ICON = {
  calendar: (c: string) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="3" fill="${c}"/><rect x="3" y="5" width="18" height="5" rx="2.5" fill="${c}"/><rect x="7" y="2.5" width="2.2" height="5" rx="1.1" fill="#fff" stroke="${c}" stroke-width="1"/><rect x="14.8" y="2.5" width="2.2" height="5" rx="1.1" fill="#fff" stroke="${c}" stroke-width="1"/><rect x="6" y="13" width="3.4" height="3" rx=".8" fill="#fff"/><rect x="10.3" y="13" width="3.4" height="3" rx=".8" fill="#fff"/><rect x="14.6" y="13" width="3.4" height="3" rx=".8" fill="#fff"/></svg>`,
  clock: (c: string) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.2" stroke="${c}" stroke-width="2.4"/><path d="M12 6.8V12l3.6 2.2" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pin: (c: string) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12Z" fill="${c}"/><circle cx="12" cy="10" r="2.9" fill="#fff"/></svg>`,
  info: (c: string, on: string) => `<svg width="26" height="26" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="${c}"/><rect x="10.6" y="10.2" width="2.8" height="7.4" rx="1.2" fill="${on}"/><circle cx="12" cy="6.9" r="1.7" fill="${on}"/></svg>`,
};

/**
 * Billet d'accès (1122 × 376 px = 297 × 99,5 mm). Trois zones, comme la maquette de la JCI :
 * artwork de l'événement (gauche) · informations + QR code (centre) · souche détachable (droite).
 * Tout le texte venant des données est échappé ; aucun script, aucune ressource externe.
 */
export function ticketHtml(d: TicketRenderData, a: DesignAssets, qrSvgMarkup: string): string {
  const p = accentPalette(d.event.accentColor);
  const gold = `linear-gradient(180deg, ${p.light} 0%, ${p.base} 48%, ${p.dark} 100%)`;
  const goldH = `linear-gradient(90deg, ${p.dark} 0%, ${p.base} 22%, ${p.light} 52%, ${p.base} 78%, ${p.dark} 100%)`;
  const date = formatDateParts(d.event.startsAt);
  const time = formatTime(d.event.startsAt);
  const holder = `${d.holderFirstName} ${d.holderLastName}`.replace(/\s+/g, ' ').trim();
  const nameSize = fit(holder, [[20, 23], [26, 19], [34, 16]], 13);
  const catSize = fit(d.categoryName, [[9, 23], [14, 19], [20, 16]], 13);
  const city = d.event.city.trim();
  const venueText = (d.event.venueName.trim() || 'Lieu à confirmer') + (city && !d.event.venueName.toLowerCase().includes(city.toLowerCase()) ? `, ${city}` : '');
  const venueSize = fit(venueText, [[22, 13], [40, 11.5], [64, 10.5]], 9.5);
  const titleSize = fit(d.event.title, [[12, 46], [20, 40], [32, 32], [50, 26]], 21);
  const stubTitleSize = fit(d.event.title, [[18, 14], [34, 12], [60, 10.5]], 9.5);
  const eventLabel = EVENT_CATEGORY_LABEL[d.event.category] ?? 'Événement';

  const art = d.posterDataUri
    ? `<img class="poster" src="${d.posterDataUri}" alt=""><div class="shade"></div>`
    : `<div class="gen"><div class="bokeh b1"></div><div class="bokeh b2"></div><div class="bokeh b3"></div><div class="bokeh b4"></div></div>
       <div class="title" style="font-size:${titleSize}px">${e(d.event.title)}</div>
       <div class="evlabel"><span>${e(eventLabel)}</span></div>`;

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Billet ${e(d.number)}</title>
<style>
${a.fontCss}
*{box-sizing:border-box;margin:0;padding:0}
@page{size:1122px 376px;margin:0}
html,body{width:1122px;height:376px;background:#fff;font-family:'Montserrat','Helvetica Neue',Arial,sans-serif;color:${BRAND.ink};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ticket{position:relative;width:1122px;height:376px;overflow:hidden;border-radius:22px;background:linear-gradient(135deg,#FFFFFF 0%,${BRAND.paper} 60%,#EEF2FA 100%);border:1px solid ${BRAND.paperEdge}}
.abs{position:absolute}

/* ── Artwork (gauche) ── */
.art{position:absolute;left:0;top:0;width:410px;height:376px;overflow:hidden;background:${BRAND.navy};clip-path:path('M0 0 H356 C 414 74, 414 302, 356 376 H0 Z')}
.art .poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center}
.art .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(4,12,38,.80) 0%,rgba(4,12,38,.18) 34%,rgba(4,12,38,0) 62%,rgba(4,12,38,.30) 100%)}
.art .gen{position:absolute;inset:0;background:radial-gradient(120% 90% at 18% 28%,#18448A 0%,${BRAND.navy} 46%,${BRAND.navyDeep} 100%)}
.bokeh{position:absolute;border-radius:50%;background:radial-gradient(circle,${p.light}CC 0%,${p.base}55 38%,${p.base}00 70%)}
.b1{left:268px;top:44px;width:74px;height:74px}.b2{left:16px;top:262px;width:96px;height:96px;opacity:.8}.b3{left:300px;top:250px;width:54px;height:54px;opacity:.7}.b4{left:150px;top:300px;width:40px;height:40px;opacity:.6}
.art .title{position:absolute;left:30px;top:112px;width:318px;color:#fff;font-weight:800;line-height:1.06;letter-spacing:-.3px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 2px 12px rgba(0,0,0,.35)}
.art .evlabel{position:absolute;left:30px;top:296px}
.evlabel span{display:inline-block;padding:9px 26px 9px 22px;border-radius:30px;background:${gold};color:${p.onAccent};font-style:italic;font-weight:800;font-size:18px;box-shadow:0 3px 10px rgba(0,0,0,.3)}
.art .logo{position:absolute;left:26px;top:18px;width:104px;height:auto;filter:drop-shadow(0 1px 6px rgba(0,0,0,.35))}
.swoosh{position:absolute;left:0;top:0}

/* ── Centre ── */
.deco{position:absolute;right:226px;bottom:0;width:340px;height:190px;opacity:.07;background:repeating-linear-gradient(45deg,${p.dark} 0 2px,transparent 2px 15px),repeating-linear-gradient(-45deg,${p.dark} 0 2px,transparent 2px 15px);-webkit-mask-image:linear-gradient(135deg,transparent 30%,#000 100%);mask-image:linear-gradient(135deg,transparent 30%,#000 100%)}
.head{position:absolute;left:424px;top:16px;width:474px;height:62px;display:flex;align-items:center;justify-content:space-between}
.head img{width:92px;height:auto;display:block}
.head .right{text-align:right}
.head .kind{font-style:italic;font-weight:700;font-size:17px;color:${BRAND.logoNavy};margin-bottom:5px}
.pill{display:inline-block;padding:6px 16px;border-radius:12px;background:${p.softBg};border:1.5px solid ${p.base};font-weight:700;font-size:13.5px;color:${BRAND.ink};letter-spacing:.2px}
.main{position:absolute;left:424px;top:88px;width:356px}
.lbl{font-weight:600;font-size:11.5px;color:${BRAND.muted};margin-bottom:5px;letter-spacing:.2px}
.field{height:42px;border-radius:15px;background:linear-gradient(180deg,#FFF9EC,${p.softBg});border:1.5px solid ${p.light};display:flex;align-items:center;padding:0 16px;font-weight:800;color:${BRAND.ink};font-size:${nameSize}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.info{display:flex;align-items:center;margin-top:16px;height:58px}
.blk{display:flex;align-items:center;gap:7px;padding:0 12px;border-left:1.5px solid #D5DBEA;height:54px}
.blk:first-child{padding-left:0;border-left:0}
.blk svg{flex:none}
.blk .t1{font-weight:800;color:${BRAND.ink};line-height:1.05}
.blk .t2{font-weight:600;font-size:11.5px;color:${BRAND.muted};margin-top:2px}
.d{width:122px}.t{width:106px}.v{flex:1;min-width:0}
.d .day{font-size:22px}.d .my{font-size:11.5px;font-weight:700;color:${BRAND.ink};margin-top:1px;white-space:nowrap}
.t .t1{font-size:17px;white-space:nowrap}
.v .t1{font-size:${venueSize}px;text-transform:uppercase;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;line-height:1.14;letter-spacing:.1px}
.cat{display:flex;align-items:center;margin-top:12px;height:42px}
.ribbon{height:42px;display:flex;align-items:center;padding:0 34px 0 32px;background:${goldH};clip-path:polygon(0 50%,16px 0,100% 0,100% 100%,16px 100%);color:${p.onAccent};font-style:italic;font-weight:800;font-size:${catSize}px;white-space:nowrap;max-width:200px;overflow:hidden}
.price{height:42px;margin-left:-20px;padding:0 22px;border-radius:21px;background:linear-gradient(180deg,#123A82,${BRAND.navy});color:#fff;font-weight:800;font-size:20px;display:flex;align-items:center;white-space:nowrap;box-shadow:0 3px 8px rgba(10,33,80,.35)}
.qrcol{position:absolute;left:790px;top:88px;width:108px;text-align:center}
.qrbox{width:108px;height:108px;border-radius:13px;background:#fff;border:2.5px solid ${p.base};padding:8px;box-shadow:0 2px 8px rgba(10,33,80,.12)}
.qrbox svg{width:100%;height:100%;display:block}
.qrnum{margin-top:7px;font-weight:700;font-size:10.5px;color:${BRAND.ink};letter-spacing:.2px;white-space:nowrap}
.note{position:absolute;left:424px;top:300px;width:474px;height:56px;border-radius:13px;background:linear-gradient(180deg,#FFFCF4,${p.softBg});border:1.5px solid ${p.light};display:flex;align-items:center;gap:11px;padding:0 14px}
.note svg{flex:none}
.note p{font-weight:600;font-size:11.5px;line-height:1.32;color:${BRAND.ink}}
.note p b{font-weight:800}

/* ── Souche ── */
.stub{position:absolute;left:908px;top:0;width:214px;height:376px;background:linear-gradient(170deg,#0E2F6B 0%,${BRAND.navy} 46%,${BRAND.navyDeep} 100%);overflow:hidden;color:#fff;text-align:center}
.stub .logo{position:absolute;left:55px;top:16px;width:104px;height:auto}
.stub .rib{position:absolute;left:19px;top:92px;width:176px;height:34px;display:flex;align-items:center;justify-content:center;background:${goldH};clip-path:polygon(0 50%,13px 0,calc(100% - 13px) 0,100% 50%,calc(100% - 13px) 100%,13px 100%);color:${p.onAccent};font-style:italic;font-weight:800;font-size:${fit(d.categoryName, [[10, 17], [16, 14], [24, 12]], 10.5)}px;padding:0 18px;white-space:nowrap;overflow:hidden}
.stub .pr{position:absolute;left:19px;top:134px;width:176px;height:40px;border:2px solid ${p.base};border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:19px;background:rgba(255,255,255,.05)}
.stub .ev{position:absolute;left:14px;top:182px;width:186px;height:34px;font-style:italic;font-weight:700;font-size:${stubTitleSize}px;line-height:1.14;color:${p.light};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.stub .qr{position:absolute;left:55px;top:226px;width:104px;height:104px;border-radius:12px;background:#fff;padding:8px}
.stub .qr svg{width:100%;height:100%;display:block}
.stub .num{position:absolute;left:0;right:0;top:340px;font-weight:700;font-size:10.5px;letter-spacing:.3px}
.stub .sw{position:absolute;right:0;bottom:0}

/* ── Perforation et encoches ── */
.perf{position:absolute;left:903px;top:20px;height:336px;border-left:2px dashed #AEB8D6}
.notch{position:absolute;width:26px;height:26px;border-radius:50%;background:#fff}
</style></head><body>
<div class="ticket">
  <div class="deco"></div>

  <div class="art">
    ${art}
    <img class="logo" src="${a.logoWhite}" alt="">
  </div>
  <svg class="swoosh" width="430" height="376" viewBox="0 0 430 376" fill="none">
    <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.light}"/><stop offset=".5" stop-color="${p.base}"/><stop offset="1" stop-color="${p.dark}"/></linearGradient></defs>
    <path d="M356 0 C 414 74, 414 302, 356 376" stroke="url(#g1)" stroke-width="7"/>
    <path d="M345 0 C 400 74, 400 302, 345 376" stroke="${p.light}" stroke-opacity=".55" stroke-width="1.6"/>
  </svg>

  <div class="head">
    <img src="${a.logoColor}" alt="JCI Comé Excellence">
    <div class="right"><div class="kind">Billet d’accès</div><div class="pill">N° ${e(d.number)}</div></div>
  </div>

  <div class="main">
    <div class="lbl">Nom du participant</div>
    <div class="field">${e(holder)}</div>
    <div class="info">
      <div class="blk d">${ICON.calendar(p.base)}<div><div class="t1 day">${e(date.day)}</div><div class="my">${e(date.monthYear)}</div></div></div>
      <div class="blk t">${ICON.clock(p.base)}<div class="t1">${e(time)}</div></div>
      <div class="blk v">${ICON.pin(p.base)}<div style="min-width:0"><div class="t1">${e(venueText)}</div></div></div>
    </div>
    <div class="cat"><div class="ribbon">${e(d.categoryName)}</div><div class="price">${e(formatPrice(d.priceXof))}</div></div>
  </div>

  <div class="qrcol"><div class="qrbox">${qrSvgMarkup}</div><div class="qrnum">${e(d.number)}</div></div>

  <div class="note">${ICON.info(p.base, p.onAccent)}<p>Présentez ce billet à l’entrée (version numérique ou imprimée).<br>Ce billet est personnel et non transférable.${d.conditions ? `<br><b>${e(d.conditions)}</b>` : ''}</p></div>

  <div class="stub">
    <img class="logo" src="${a.logoWhite}" alt="">
    <div class="rib">${e(d.categoryName)}</div>
    <div class="pr">${e(formatPrice(d.priceXof))}</div>
    <div class="ev">${e(d.event.title)}</div>
    <div class="qr">${qrSvgMarkup}</div>
    <div class="num">${e(d.number)}</div>
    <svg class="sw" width="64" height="56" viewBox="0 0 64 56" fill="none"><path d="M64 14 C 46 22, 30 36, 18 56" stroke="${p.base}" stroke-opacity=".95" stroke-width="5"/><path d="M64 30 C 52 36, 42 44, 34 56" stroke="${p.light}" stroke-opacity=".5" stroke-width="2"/></svg>
  </div>

  <div class="perf"></div>
  <div class="notch" style="left:895px;top:-13px"></div>
  <div class="notch" style="left:895px;bottom:-13px"></div>
  <div class="notch" style="right:-15px;top:175px;width:30px;height:30px"></div>
</div></body></html>`;
}
