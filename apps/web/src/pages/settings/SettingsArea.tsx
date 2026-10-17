import { Outlet } from 'react-router-dom';
import { SettingsTemplate } from '@/components/templates';
import { useSettingsRail } from './settingsRail';

/**
 * Settings & Trust (UX upgrade step 3; design system §4.4): one area, one
 * rail, for everything an organization configures and everything an
 * auditor or IT admin checks. The pages did not move: this is a layout
 * route around their existing paths, so every link and pin still works
 * and each page keeps its own header. The rail (pages/settings/settingsRail)
 * shows only what this person may open; the overview at /admin draws the
 * same list as cards.
 */
export function SettingsArea() {
  const rail = useSettingsRail();
  return (
    <SettingsTemplate areaLabel="Settings & Trust" rail={rail}>
      <Outlet />
    </SettingsTemplate>
  );
}
