-- Brief 2-1b, step 1: the tenant profile. Additive only.
--
-- businessModel sets defaults and is otherwise informational; modules and
-- terminology are validated JSON (the shared schema in
-- packages/shared/src/tenantProfile.ts). An empty object means "the
-- defaults for the business model"; Alto HR is written out in full as a
-- WORKFORCE_PROVIDER with every module on and its current vocabulary, so
-- a later change to the defaults never changes Alto HR by accident.
DO $$ BEGIN
  CREATE TYPE "BusinessModel" AS ENUM ('DIRECT_EMPLOYER', 'WORKFORCE_PROVIDER', 'MANAGED_PROGRAM', 'HYBRID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "businessModel" "BusinessModel" NOT NULL DEFAULT 'WORKFORCE_PROVIDER',
  ADD COLUMN IF NOT EXISTS "modules" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "terminology" JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE "Tenant"
SET "businessModel" = 'WORKFORCE_PROVIDER',
    "modules" = '{"scheduling":true,"time":true,"hrCases":true,"compliance":true,"payrollSync":true,"housingLink":true,"transportation":true,"programs":true,"billRates":true,"clientPortal":true,"robotics":true,"agentBuilder":true}'::jsonb,
    "terminology" = '{
      "worker":{"en":"Associate","es":"Asociado","tr":"Çalışan"},
      "workers":{"en":"Associates","es":"Asociados","tr":"Çalışanlar"},
      "site":{"en":"Store","es":"Tienda","tr":"Mağaza"},
      "sites":{"en":"Stores","es":"Tiendas","tr":"Mağazalar"},
      "manager":{"en":"Supervisor","es":"Supervisor","tr":"Süpervizör"},
      "managers":{"en":"Supervisors","es":"Supervisores","tr":"Süpervizörler"},
      "nav.people":{"en":"People","es":"Personas","tr":"Kişiler"},
      "nav.scheduling":{"en":"Scheduling","es":"Horarios","tr":"Planlama"},
      "nav.time":{"en":"Time","es":"Tiempo","tr":"Zaman"},
      "nav.kiosk":{"en":"Kiosk","es":"Kiosco","tr":"Kiosk"},
      "nav.hrCases":{"en":"HR cases","es":"Casos de RR. HH.","tr":"İK vakaları"},
      "nav.compliance":{"en":"Compliance","es":"Cumplimiento","tr":"Uyum"},
      "nav.documents":{"en":"Documents","es":"Documentos","tr":"Belgeler"},
      "nav.payroll":{"en":"Payroll","es":"Nómina","tr":"Bordro"},
      "nav.transport":{"en":"Transportation","es":"Transporte","tr":"Ulaşım"},
      "nav.clients":{"en":"Clients","es":"Clientes","tr":"Müşteriler"},
      "nav.programs":{"en":"Programs","es":"Programas","tr":"Programlar"},
      "nav.headcount":{"en":"Headcount","es":"Plantilla","tr":"Kadro"},
      "role.associate":{"en":"Associate","es":"Asociado","tr":"Çalışan"},
      "role.shiftSupervisor":{"en":"Shift supervisor","es":"Supervisor de turno","tr":"Vardiya süpervizörü"},
      "role.floorSupervisor":{"en":"Floor supervisor","es":"Supervisor de piso","tr":"Kat süpervizörü"},
      "role.manager":{"en":"Manager","es":"Gerente","tr":"Yönetici"},
      "role.clientPortal":{"en":"Client portal","es":"Portal del cliente","tr":"Müşteri portalı"},
      "role.transportationDirector":{"en":"Transportation director","es":"Director de transporte","tr":"Ulaşım direktörü"},
      "role.driver":{"en":"Driver","es":"Conductor","tr":"Sürücü"},
      "label.client":{"en":"Client","es":"Cliente","tr":"Müşteri"},
      "label.clients":{"en":"Clients","es":"Clientes","tr":"Müşteriler"},
      "label.shift":{"en":"Shift","es":"Turno","tr":"Vardiya"},
      "label.timesheet":{"en":"Timesheet","es":"Hoja de horas","tr":"Puantaj"},
      "label.paystub":{"en":"Paystub","es":"Recibo de pago","tr":"Maaş bordrosu"},
      "label.supervisor":{"en":"Supervisor","es":"Supervisor","tr":"Süpervizör"},
      "label.supervisors":{"en":"Supervisors","es":"Supervisores","tr":"Süpervizörler"},
      "label.store":{"en":"Store","es":"Tienda","tr":"Mağaza"},
      "label.stores":{"en":"Stores","es":"Tiendas","tr":"Mağazalar"}
    }'::jsonb
WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid;
