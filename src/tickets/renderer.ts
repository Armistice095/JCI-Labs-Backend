import { Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { SHARE_H, SHARE_W, TICKET_H, TICKET_W } from './design/types';

const CANDIDATES: Record<string, string[]> = {
  linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
};

export function resolveChromium(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CHROMIUM_PATH ne pointe vers aucun fichier : ${explicit}`);
    return explicit;
  }
  const found = (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p));
  if (!found) throw new Error("Chromium/Chrome introuvable. Installez-le (Docker : paquet « chromium ») ou définissez CHROMIUM_PATH.");
  return found;
}

/** Hébergement à mémoire serrée (ex. 512 Mo) : un seul processus Chromium, pas d'isolation de sites, pas de services d'arrière-plan. Un peu plus lent, nettement plus léger. */
const LOW_MEMORY_ARGS = [
  '--single-process', '--no-zygote', '--renderer-process-limit=1', '--disable-site-isolation-trials',
  '--disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter',
  '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--metrics-recording-only',
  '--js-flags=--max-old-space-size=128',
];

export interface RenderedTicket { pdf: Buffer; png: Buffer }

/**
 * Rend du HTML en PDF/PNG/JPEG avec Chromium. Un navigateur partagé, au plus `maxPages` rendus simultanés.
 * Sécurité : le HTML ne contient aucun script ; toute requête réseau est refusée (seules les data-URI passent).
 */
export class ChromiumRenderer {
  private readonly log = new Logger(ChromiumRenderer.name);
  private browser: Promise<Browser> | null = null;
  private active = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private closing = false; // arrêt voulu : pas d'avertissement « Chromium arrêté »
  private readonly queue: (() => void)[] = [];

  constructor(private readonly opts: { executablePath?: string; headlessShell?: boolean; maxPages?: number; lowMemory?: boolean; idleCloseMs?: number } = {}) {}

  private async launch(): Promise<Browser> {
    const b = await puppeteer.launch({
      executablePath: resolveChromium(this.opts.executablePath),
      headless: this.opts.headlessShell ? 'shell' : true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none', '--hide-scrollbars', '--disable-extensions', '--no-first-run', '--mute-audio',
        ...(this.opts.lowMemory ? LOW_MEMORY_ARGS : []),
      ],
    });
    b.on('disconnected', () => { if (!this.closing) this.log.warn('Chromium arrêté : il sera relancé au prochain rendu'); this.browser = null; });
    this.log.log(`Chromium prêt (${await b.version()})`);
    return b;
  }

  private getBrowser(): Promise<Browser> {
    this.browser ??= this.launch().catch((e) => { this.browser = null; throw e; });
    return this.browser;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.opts.maxPages ?? (this.opts.lowMemory ? 1 : 2);
    if (this.active >= max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try { return await fn(); } finally { this.active--; this.queue.shift()?.(); this.scheduleIdleClose(); }
  }

  private async withPage<T>(w: number, h: number, scale: number, html: string, fn: (p: Page) => Promise<T>): Promise<T> {
    return this.slot(async () => {
      const browser = await this.getBrowser();
      const page = await browser.newPage();
      try {
        page.setDefaultTimeout(30_000);
        await page.setViewport({ width: w, height: h, deviceScaleFactor: scale });
        await page.setRequestInterception(true);
        page.on('request', (r) => { const u = r.url(); if (u.startsWith('data:') || u === 'about:blank') void r.continue(); else void r.abort(); });
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => (document as any).fonts.ready);
        return await fn(page);
      } finally {
        await page.close().catch(() => undefined);
      }
    });
  }

  /** Billet : PDF (297 × 99,5 mm, texte et QR vectoriels) + PNG haute définition (2×), à partir du même HTML. */
  async renderTicket(html: string): Promise<RenderedTicket> {
    return this.withPage(TICKET_W, TICKET_H, 2, html, async (page) => {
      const png = Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: TICKET_W, height: TICKET_H } }));
      const pdf = Buffer.from(await page.pdf({ width: `${TICKET_W}px`, height: `${TICKET_H}px`, printBackground: true, preferCSSPageSize: true, pageRanges: '1' }));
      return { pdf, png };
    });
  }

  /** Visuel de partage (1080 × 1920) en JPEG : léger, accepté partout (statut WhatsApp, Facebook). */
  async renderShare(html: string): Promise<Buffer> {
    return this.withPage(SHARE_W, SHARE_H, 1, html, async (page) =>
      Buffer.from(await page.screenshot({ type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: SHARE_W, height: SHARE_H } })));
  }

  /** Hébergement à mémoire serrée : Chromium s'éteint quand plus rien n'est à rendre et redémarre au rendu suivant (~1 s). */
  private scheduleIdleClose() {
    const ms = this.opts.idleCloseMs ?? (this.opts.lowMemory ? 20_000 : 0);
    if (!ms || this.active > 0 || this.queue.length > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.active === 0) void this.close(); }, ms);
    this.idleTimer.unref();
  }

  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const b = this.browser; this.browser = null;
    if (b) { this.closing = true; try { await (await b).close(); } catch { /* déjà arrêté */ } finally { this.closing = false; } }
  }
}
