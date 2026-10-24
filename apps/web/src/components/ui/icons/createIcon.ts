import { createElement, forwardRef, type ForwardRefExoticComponent, type RefAttributes, type SVGProps } from 'react';

/**
 * The icon runtime (docs/design-system.md §6). Every icon in the app is a
 * Phosphor glyph (MIT) drawn on its 256-unit grid and filled with
 * currentColor; the glyphs themselves are generated into ./glyphs by
 * scripts/build-icons.mjs, with only the weights each one is used at:
 *
 *   bold     every interface icon, h-2.5 to h-6 (12–24 px)
 *   fill     where the code marks the current nav row or tab: `icon-active`
 *   duotone  illustrations, sized h-8 (32 px) and up — empty states, the
 *            not-found and no-access pages, the kiosk's big marks
 *
 * A component picks its weight from its own className, so call sites stay
 * as they were: `<Inbox className="h-4 w-4" />`.
 */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'strokeWidth'> {
  /** Width and height when no size class is given, as Lucide's prop was. Default 24. */
  size?: number | string;
}

export type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;
/** The type the app's icon props were written against; kept so they read as before. */
export type LucideIcon = Icon;
export type LucideProps = IconProps;

/**
 * One glyph's paths, per weight. `b` bold, `f` fill, `d` duotone — its first
 * path is the 20% tint layer ('' when the glyph has none), the rest solid.
 */
export interface Glyph {
  b: string | readonly string[];
  f?: string | readonly string[];
  d?: readonly string[];
}

const ACTIVE = /(?:^|\s)icon-active(?:\s|$)/;
const SIZE_CLASS = /(?:^|\s)(?:[\w-]+:)*(?:h|size)-(\d+)(?=\s|$)/g;

/** h-8 (32 px) and up is an illustration. */
function isIllustration(className: string, size: number | string): boolean {
  for (const m of className.matchAll(SIZE_CLASS)) if (Number(m[1]) >= 8) return true;
  return typeof size === 'number' ? size >= 32 : Number.parseFloat(size) >= 32;
}

const paths = (d: string | readonly string[]) =>
  (typeof d === 'string' ? [d] : d).map((p, i) => createElement('path', { key: i, d: p }));

export function createIcon(name: string, glyph: Glyph): Icon {
  const Component = forwardRef<SVGSVGElement, IconProps>(function PhosphorIcon({ size = 24, className, ...rest }, ref) {
    const cls = className ?? '';
    let children;
    if (glyph.f && ACTIVE.test(cls)) children = paths(glyph.f);
    else if (glyph.d && isIllustration(cls, size)) {
      const [tint, ...solid] = glyph.d;
      children = [...(tint ? [createElement('path', { key: 'tint', d: tint, opacity: 0.2 })] : []), ...paths(solid)];
    } else children = paths(glyph.b);
    const labelled = rest['aria-label'] != null || rest['aria-labelledby'] != null;
    return createElement(
      'svg',
      {
        ref,
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: '0 0 256 256',
        fill: 'currentColor',
        focusable: 'false',
        'aria-hidden': labelled ? undefined : true,
        role: labelled ? 'img' : undefined,
        ...rest,
        className: className ? `icon ${className}` : 'icon',
      },
      children,
    );
  });
  Component.displayName = name;
  return Component;
}
