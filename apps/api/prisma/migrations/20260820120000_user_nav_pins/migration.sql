-- Sidebar pins move server-side: localStorage pins were wiped by the
-- sign-out sweep and by mobile-browser storage eviction, and never
-- followed the user across devices.
ALTER TABLE "User" ADD COLUMN "pinnedModules" TEXT[] NOT NULL DEFAULT '{}';
