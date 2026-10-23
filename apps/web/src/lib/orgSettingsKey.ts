/**
 * The org-settings query (GET /admin/org/settings) every page that edits
 * those settings shares — Branding, Finance, Approval rules, Sign-in's
 * two-step and Organization's calendar — so a save on one is what the
 * others show. Its own module so a test that mocks lib/brandingApi keeps it.
 */
export const ORG_SETTINGS_KEY = ['BrandingHome', 'branding'] as const;
