-- ============================================================================
-- Row-level security (phase 8). See docs/adr/009-row-level-security.md.
--
-- Two goals:
--  1. On Supabase every table in `public` is reachable through PostgREST with
--     the anon key. Enabling RLS with no policies for `anon`/`authenticated`
--     closes that door. The app connects as the table owner (Prisma), which
--     RLS does not restrict, so nothing else changes.
--  2. A tenant-scoped role, `app_tenant`, that can only see rows of the
--     business named in the transaction setting `app.business_id` (NULLIF
--     because a setting that was SET LOCAL earlier in the session reads back
--     as '' rather than NULL after the transaction ends). Not used by
--     the app yet; it is the multi-tenant guard rail, proven by a test that
--     runs `SET LOCAL ROLE app_tenant`.
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_tenant;

-- Tenant-owned tables (have business_id).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'staff', 'resources', 'services', 'availability_rules', 'availability_overrides',
    'customers', 'bookings', 'users', 'messages', 'conversations', 'payments',
    'calendar_connections', 'calendar_blocks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_tenant', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I FOR ALL TO app_tenant
        USING (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
        WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
    $p$, t);
  END LOOP;
END $$;

-- The business row itself.
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON businesses TO app_tenant;
CREATE POLICY tenant_isolation ON businesses FOR ALL TO app_tenant
  USING (id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.business_id', true), '')::uuid);

-- Child tables without business_id: scope through the parent.
ALTER TABLE service_staff ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_staff TO app_tenant;
CREATE POLICY tenant_isolation ON service_staff FOR ALL TO app_tenant
  USING (EXISTS (SELECT 1 FROM services s WHERE s.id = service_id
                 AND s.business_id = NULLIF(current_setting('app.business_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM services s WHERE s.id = service_id
                 AND s.business_id = NULLIF(current_setting('app.business_id', true), '')::uuid));

ALTER TABLE booking_resources ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON booking_resources TO app_tenant;
CREATE POLICY tenant_isolation ON booking_resources FOR ALL TO app_tenant
  USING (EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_id
                 AND b.business_id = NULLIF(current_setting('app.business_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_id
                 AND b.business_id = NULLIF(current_setting('app.business_id', true), '')::uuid));

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO app_tenant;
CREATE POLICY tenant_isolation ON calendar_events FOR ALL TO app_tenant
  USING (EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_id
                 AND b.business_id = NULLIF(current_setting('app.business_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_id
                 AND b.business_id = NULLIF(current_setting('app.business_id', true), '')::uuid));

-- Global operational tables: RLS on, no tenant policy. Only the app (owner)
-- reads these; PostgREST roles and app_tenant get nothing.
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
