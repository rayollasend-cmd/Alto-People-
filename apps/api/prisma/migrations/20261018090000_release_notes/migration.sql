-- "What's new" release notes, served by the API instead of compiled into
-- the web bundle. One row per release; `items` holds the bullets with
-- their audience and both languages.
CREATE TABLE "ReleaseNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day" DATE NOT NULL,
    "items" JSONB NOT NULL,
    "publishedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ReleaseNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReleaseNote_publishedAt_day_idx" ON "ReleaseNote"("publishedAt", "day");

-- The two notes the web bundle used to carry, so nobody's card goes blank
-- on the release that moved them here.
INSERT INTO "ReleaseNote" ("day", "items", "publishedAt", "updatedAt") VALUES
(
  '2026-09-03',
  '[
    {"audience":"ALL","en":"Set your profile photo with a proper position-and-zoom step — Settings → Profile photo.","es":"Configura tu foto de perfil con ajuste de posición y zoom — Ajustes → Foto de perfil."},
    {"audience":"ALL","en":"Confirm a shift with one tap, right from the schedule list.","es":"Confirma un turno con un toque, directo desde tu horario."},
    {"audience":"ALL","en":"Your clock-in number now lives on your Home screen — tap to reveal.","es":"Tu número para marcar ahora está en tu pantalla de inicio — tócalo para verlo."},
    {"audience":"ADMIN","en":"Cross-client transfers, kiosk PIN tools on the People profile, tiered admin email, and a bell that clears when you open it.","es":null}
  ]'::jsonb,
  '2026-09-03T12:00:00Z',
  CURRENT_TIMESTAMP
),
(
  '2026-07-02',
  '[
    {"audience":"ADMIN","en":"Pin your most-used pages — hover a sidebar item and tap the star.","es":null},
    {"audience":"ADMIN","en":"Press ⌘K to search people and clients, not just pages.","es":null},
    {"audience":"ADMIN","en":"Approvals now show a live count badge and update instantly.","es":null},
    {"audience":"ALL","en":"You''ll get “Your week ahead” the evening before your work week starts.","es":"Recibirás “Tu semana” la noche antes de que empiece tu semana laboral."},
    {"audience":"ALL","en":"La aplicación ahora habla español — cámbialo en el menú.","es":"La aplicación ahora habla español — cámbialo en el menú."}
  ]'::jsonb,
  '2026-07-02T12:00:00Z',
  CURRENT_TIMESTAMP
);
