import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SettingsService {
  private cache: { ttl: number; at: number } | null = null;
  constructor(private readonly prisma: PrismaService) {}

  /** Durée de réservation des places pendant le paiement (défaut 15 min, bornée à 5–60). */
  async reservationTtlMinutes(): Promise<number> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.ttl;
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'reservation_ttl_minutes' } });
    const raw = typeof row?.value === 'number' ? row.value : Number(row?.value);
    const ttl = Number.isFinite(raw) ? Math.min(60, Math.max(5, Math.round(raw))) : 15;
    this.cache = { ttl, at: Date.now() };
    return ttl;
  }
}
