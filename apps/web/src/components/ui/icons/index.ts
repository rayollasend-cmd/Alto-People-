/**
 * The one place icons come from (docs/design-system.md §6). Phosphor glyphs
 * under the Lucide names the app was written with; scripts/icon-lint.mjs
 * fails an icon imported from anywhere else.
 */
export * from './generated';
export type { Icon, IconProps, LucideIcon, LucideProps } from './createIcon';
