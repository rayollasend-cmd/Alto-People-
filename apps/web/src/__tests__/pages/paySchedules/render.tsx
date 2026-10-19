import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { renderAs } from '../hrPack/harness';

/** A payroll accountant at `route`, with the page mounted at `path` and a marker for wherever it navigates. */
export function renderPage(ui: ReactNode, route: string, path = route) {
  return renderAs(
    'FINANCE_ACCOUNTANT',
    <TooltipProvider>
      <Routes>
        <Route path={path} element={ui} />
        <Route path="*" element={<p>Navigated away</p>} />
      </Routes>
    </TooltipProvider>,
    route,
  );
}
