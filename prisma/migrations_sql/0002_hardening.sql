-- À exécuter APRÈS la migration Prisma initiale (connexion directe, rôle postgres).
-- Ne pas utiliser FORCE ROW LEVEL SECURITY : le propriétaire des tables (postgres) doit contourner le RLS.

-- ───────────── 1. Lien avec Supabase Auth ─────────────
ALTER TABLE profiles
  ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- ───────────── 2. Contraintes d'intégrité ─────────────
ALTER TABLE events
  ADD CONSTRAINT chk_event_dates      CHECK (ends_at > starts_at),
  ADD CONSTRAINT chk_event_sales      CHECK (sales_closes_at IS NULL OR sales_opens_at IS NULL OR sales_closes_at > sales_opens_at),
  ADD CONSTRAINT chk_event_max_order  CHECK (max_per_order BETWEEN 1 AND 10),
  ADD CONSTRAINT chk_event_slug       CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT chk_event_color      CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$');

ALTER TABLE ticket_categories
  ADD CONSTRAINT chk_cat_price   CHECK (price_xof >= 0),
  ADD CONSTRAINT chk_cat_counts  CHECK (quota >= 0 AND sold_count >= 0 AND reserved_count >= 0
                                        AND sold_count + reserved_count <= quota),
  ADD CONSTRAINT chk_cat_period  CHECK (sale_ends_at IS NULL OR sale_starts_at IS NULL OR sale_ends_at > sale_starts_at),
  ADD CONSTRAINT chk_cat_max     CHECK (max_per_order IS NULL OR max_per_order BETWEEN 1 AND 10),
  ADD CONSTRAINT uq_cat_id_event UNIQUE (id, event_id);

ALTER TABLE order_items ADD CONSTRAINT chk_item_qty CHECK (quantity > 0 AND unit_price_xof >= 0);
ALTER TABLE orders      ADD CONSTRAINT chk_order_total CHECK (total_xof >= 0);
ALTER TABLE payments    ADD CONSTRAINT chk_pay_amounts CHECK (expected_amount_xof >= 0
                                                              AND (confirmed_amount_xof IS NULL OR confirmed_amount_xof >= 0));

-- Un billet appartient forcément à une catégorie du même événement
ALTER TABLE tickets
  ADD CONSTRAINT tickets_category_event_fkey
  FOREIGN KEY (category_id, event_id) REFERENCES ticket_categories (id, event_id);

-- Cohérence de l'état d'un billet
ALTER TABLE tickets
  ADD CONSTRAINT chk_ticket_used      CHECK (status <> 'USED' OR (checked_in_at IS NOT NULL AND checked_in_by_id IS NOT NULL)),
  ADD CONSTRAINT chk_ticket_cancelled CHECK (status NOT IN ('CANCELLED','REFUNDED') OR cancelled_at IS NOT NULL);

-- Au plus un paiement confirmé par commande
CREATE UNIQUE INDEX uq_payments_one_paid_per_order ON payments (order_id) WHERE status = 'PAID';

-- Rôles : unicité avec portée optionnelle (NULL n'est pas unique en SQL)
CREATE UNIQUE INDEX uq_user_roles_global ON user_roles (user_id, role_id) WHERE event_id IS NULL;
CREATE UNIQUE INDEX uq_user_roles_scoped ON user_roles (user_id, role_id, event_id) WHERE event_id IS NOT NULL;

-- Une seule affiche de couverture par événement
CREATE UNIQUE INDEX uq_one_cover_per_event ON event_posters (event_id) WHERE is_cover;

-- Recherche de participants / commandes
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_tickets_holder_trgm ON tickets USING gin ((holder_last_name || ' ' || holder_first_name) gin_trgm_ops);
CREATE INDEX idx_orders_buyer_trgm   ON orders  USING gin ((buyer_last_name  || ' ' || buyer_first_name)  gin_trgm_ops);

-- ───────────── 3. Numérotation ─────────────
CREATE OR REPLACE FUNCTION next_counter(p_key text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO counters (key, value) VALUES (p_key, 1)
  ON CONFLICT (key) DO UPDATE SET value = counters.value + 1
  RETURNING value;
$$;
-- Usage : 'CMD-' || next_counter('order')   |   'JCI-2026-' || lpad(next_counter('ticket:2026')::text, 6, '0')

-- ───────────── 4. Verrouillage Supabase (RLS sans politique) ─────────────
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Contrôle à lancer en CI après chaque migration : doit retourner 0 ligne
--   SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity;
