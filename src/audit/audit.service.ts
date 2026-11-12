import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorId: string | null;
  action: string;       // ex. "event.publish", "user.disable"
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Passer `tx` pour journaliser dans la même transaction que l'action. */
  async log(e: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    await (tx ?? this.prisma).auditLog.create({
      data: { actorId: e.actorId, action: e.action, entityType: e.entityType, entityId: e.entityId ?? null, metadata: e.metadata, ip: e.ip ?? null },
    });
  }
}
