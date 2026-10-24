import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { ChevronDown, House, Home, Inbox, Lock, Settings, Settings2 } from '@/components/ui/icons';

/**
 * The icon component (docs/design-system.md §6): a Phosphor glyph on its
 * 256-unit grid, filled with currentColor, out of the accessibility tree
 * unless it is named, and drawn bold — fill when the className marks the
 * current nav row (`icon-active`), duotone from h-8 up.
 */
const svgOf = (ui: React.ReactElement) => render(ui).container.querySelector('svg')!;
const pathsOf = (svg: SVGSVGElement) => [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'));

describe('icons', () => {
  it('draws a filled glyph, hidden from assistive tech, keeping the call site’s classes', () => {
    const svg = svgOf(<ChevronDown className="h-4 w-4 text-gold" />);
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 256');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('class')).toBe('icon h-4 w-4 text-gold');
    expect(svg.getAttribute('width')).toBe('24');
  });

  it('is named when given a label, and passes refs, sizes and data attributes through', () => {
    const ref = createRef<SVGSVGElement>();
    const svg = svgOf(<Lock ref={ref} size={20} aria-label="Locked" data-testid="lock" />);
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Locked');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.dataset.testid).toBe('lock');
    expect(ref.current).toBe(svg);
  });

  it('draws bold, fill when active, duotone as an illustration', () => {
    const bold = pathsOf(svgOf(<Inbox className="h-4 w-4" />));
    const active = pathsOf(svgOf(<Inbox className="h-4 w-4 icon-active" />));
    expect(bold).toEqual(pathsOf(svgOf(<Inbox className="h-6 w-6" />)));
    expect(active).not.toEqual(bold);

    const illustration = svgOf(<Lock className="h-8 w-8" />);
    expect(illustration.querySelector('path')?.getAttribute('opacity')).toBe('0.2');
    expect(pathsOf(svgOf(<Lock className="h-4 w-4" />))).not.toEqual(pathsOf(illustration));
  });

  it('falls back to bold when a weight was not generated for the glyph', () => {
    // ChevronDown is never an active nav icon or an illustration: it has bold only.
    expect(pathsOf(svgOf(<ChevronDown className="h-4 w-4 icon-active" />))).toEqual(pathsOf(svgOf(<ChevronDown className="h-4 w-4" />)));
    expect(pathsOf(svgOf(<ChevronDown className="h-10 w-10" />))).toEqual(pathsOf(svgOf(<ChevronDown />)));
  });

  it('makes names mapped to one glyph the same component', () => {
    expect(Home).toBe(House);
    expect(Settings).toBe(Settings2);
    expect(Lock.displayName).toBe('Lock');
  });
});
