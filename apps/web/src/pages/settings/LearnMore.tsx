import * as React from 'react';

/**
 * One line under a settings section, the rest behind "Learn more"
 * (F500 polish, 2026-10-26: Sign-in and Organization opened every section
 * with a paragraph). Inline content only, so it can sit inside a section's
 * description paragraph.
 */
export function LearnMore({
  children,
  label = 'Learn more',
  hideLabel = 'Show less',
}: {
  children: React.ReactNode;
  label?: string;
  hideLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <>
      {' '}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="inline rounded-sm text-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {open ? hideLabel : label}
      </button>
      {/* No display class while hidden: a utility's display:block beats the [hidden] rule. */}
      <span id={id} hidden={!open} className={open ? 'mt-1.5 block' : undefined}>
        {children}
      </span>
    </>
  );
}
