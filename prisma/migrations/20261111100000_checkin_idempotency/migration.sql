-- Contrôle d'accès : clé d'idempotence d'un scan (un scan rejoué après une coupure réseau renvoie le même résultat).
ALTER TABLE "checkin_attempts" ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "checkin_attempts_idempotency_key_key" ON "checkin_attempts"("idempotency_key");
