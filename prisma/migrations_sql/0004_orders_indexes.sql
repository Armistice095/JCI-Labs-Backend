-- Accélère le balayage des réservations expirées et des paiements en attente.
CREATE INDEX IF NOT EXISTS idx_orders_held_expiry ON orders (expires_at) WHERE reservation_held;
CREATE INDEX IF NOT EXISTS idx_payments_pending ON payments (created_at) WHERE status = 'PENDING' AND provider_transaction_id IS NOT NULL;

-- Une réservation active implique une date d'expiration.
ALTER TABLE orders ADD CONSTRAINT chk_order_hold_expiry CHECK (NOT reservation_held OR expires_at IS NOT NULL);
-- Compteurs de stock jamais négatifs (déjà dans chk_cat_counts) ; une commande payée ne détient plus de réservation.
ALTER TABLE orders ADD CONSTRAINT chk_order_paid_no_hold CHECK (status <> 'PAID' OR NOT reservation_held);
