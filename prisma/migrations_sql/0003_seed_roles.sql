-- Rôles et permissions de départ (idempotent).
-- event_scope : ALL_EVENTS = un grant global couvre tous les événements ;
--               OWN_OR_ASSIGNED = un grant global ne couvre que les événements créés par l'utilisateur
--               ou auxquels il est assigné (user_roles.event_id).

INSERT INTO roles (code, name, event_scope) VALUES
  ('ADMIN',      'Administrateur', 'ALL_EVENTS'),
  ('PRESIDENT',  'Président local', 'ALL_EVENTS'),
  ('ORGANIZER',  'Organisateur',   'OWN_OR_ASSIGNED'),
  ('SELLER',     'Vendeur',        'OWN_OR_ASSIGNED'),
  ('GATE_AGENT', 'Agent d''accueil','OWN_OR_ASSIGNED')
ON CONFLICT (code) DO NOTHING;

WITH perms(role_code, permission) AS (VALUES
  -- ADMIN : tout
  ('ADMIN','user.manage'),('ADMIN','role.manage'),('ADMIN','audit.view'),('ADMIN','settings.manage'),
  ('ADMIN','event.read'),('ADMIN','event.create'),('ADMIN','event.update'),('ADMIN','event.publish'),
  ('ADMIN','event.close'),('ADMIN','event.cancel'),('ADMIN','event.delete_draft'),
  ('ADMIN','ticketing.manage'),('ADMIN','order.read'),('ADMIN','finance.view'),
  ('ADMIN','sale.create'),('ADMIN','sale.read_all'),
  ('ADMIN','participant.read'),('ADMIN','participant.export'),
  ('ADMIN','ticket.cancel'),('ADMIN','ticket.resend'),('ADMIN','report.view'),('ADMIN','dashboard.view'),
  ('ADMIN','checkin.scan'),('ADMIN','checkin.view'),('ADMIN','checkin.override'),

  -- PRESIDENT : supervision et validation
  ('PRESIDENT','event.read'),('PRESIDENT','event.create'),('PRESIDENT','event.update'),('PRESIDENT','event.publish'),
  ('PRESIDENT','event.close'),('PRESIDENT','event.cancel'),
  ('PRESIDENT','ticketing.manage'),('PRESIDENT','order.read'),('PRESIDENT','finance.view'),
  ('PRESIDENT','sale.create'),('PRESIDENT','sale.read_all'),
  ('PRESIDENT','participant.read'),('PRESIDENT','participant.export'),
  ('PRESIDENT','ticket.cancel'),('PRESIDENT','ticket.resend'),('PRESIDENT','report.view'),('PRESIDENT','dashboard.view'),
  ('PRESIDENT','checkin.view'),('PRESIDENT','checkin.override'),

  -- ORGANIZER : crée (brouillon) et gère ses événements, ne publie pas, pas de finance globale
  ('ORGANIZER','event.read'),('ORGANIZER','event.create'),('ORGANIZER','event.update'),
  ('ORGANIZER','event.delete_draft'),('ORGANIZER','ticketing.manage'),
  ('ORGANIZER','order.read'),('ORGANIZER','participant.read'),('ORGANIZER','participant.export'),
  ('ORGANIZER','ticket.resend'),('ORGANIZER','report.view'),('ORGANIZER','dashboard.view'),('ORGANIZER','checkin.view'),

  -- SELLER : enregistre des ventes physiques, voit uniquement les siennes
  ('SELLER','event.read'),('SELLER','sale.create'),

  -- GATE_AGENT : scan et compteurs
  ('GATE_AGENT','event.read'),('GATE_AGENT','checkin.scan'),('GATE_AGENT','checkin.view')
)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM perms p JOIN roles r ON r.code = p.role_code
ON CONFLICT DO NOTHING;

-- updated_at est géré par Prisma (@updatedAt), sans valeur par défaut en base : on le fournit explicitement.
INSERT INTO app_settings (key, value, updated_at) VALUES
  ('reservation_ttl_minutes', '15', now()),
  ('sales_close_default_hour_local', '18', now())
ON CONFLICT (key) DO NOTHING;
