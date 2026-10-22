import { useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { SettingsTemplate } from '@/components/templates';
import { MODULES } from '@/lib/modules';
import { AreaTrailContext, type AreaTrail } from '@/lib/navTrail';
import { usePublishPageUp } from '@/lib/pageTitle';
import { useSettingsRail } from './settingsRail';

/** The area's own name and page — the Settings & trust module's, so the sidebar, the crumb and Back agree. */
const SETTINGS = MODULES.find((m) => m.key === 'settings')!;
const AREA = { label: SETTINGS.label, to: SETTINGS.path };

/**
 * Settings & Trust (UX upgrade step 3; design system §4.4): one area, one
 * rail, for everything an organization configures and everything an
 * auditor or IT admin checks. The pages did not move: this is a layout
 * route around their existing paths, so every link and pin still works.
 *
 * The rail (pages/settings/settingsRail) shows only what this person may
 * open, and it is the one source for the area's trail too: every page in
 * here gets "Settings & trust › <section> › <page>" from it (lib/navTrail
 * AreaTrailContext), whatever crumb it was written with. On the overview
 * (/admin) there is no rail — its cards are the same list; below lg there
 * is no rail either, and the top bar's Back goes to the overview.
 */
export function SettingsArea() {
  const rail = useSettingsRail();
  const { pathname } = useLocation();
  const atOverview = pathname === AREA.to || pathname === `${AREA.to}/`;
  const trail = useMemo<AreaTrail>(() => ({ area: AREA, rail }), [rail]);
  usePublishPageUp(atOverview ? null : AREA);
  return (
    <AreaTrailContext.Provider value={trail}>
      <SettingsTemplate areaLabel={AREA.label} rail={rail} hideRail={atOverview} railBelowLg={false}>
        <Outlet />
      </SettingsTemplate>
    </AreaTrailContext.Provider>
  );
}
