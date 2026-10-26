import { cn } from '@/lib/cn';

type LogoSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface LogoProps {
  size?: LogoSize;
  className?: string;
  alt?: string;
}

const SIZE_PX: Record<LogoSize, number> = {
  xs: 20,
  sm: 28,
  md: 40,
  lg: 64,
  xl: 96,
};

/**
 * The brand mark. Below 40px it is the vector mark (public/favicon.svg's
 * shapes) drawn in the theme's gold on no backdrop: the full logo is a
 * small emblem on its own navy square, and at the sidebar's 28px and the
 * phone header's 20px it shrank to a dark blob on the navy chrome (F500
 * audit 2026-10-26). From 40px up, the full logo with its inner detail.
 */
export function Logo({ size = 'sm', className, alt = 'Company logo' }: LogoProps) {
  const px = SIZE_PX[size];
  if (px < 40) {
    return (
      <svg
        viewBox="4 4 56 56"
        width={px}
        height={px}
        role="img"
        aria-label={alt}
        className={cn('shrink-0 text-gold', className)}
        style={{ width: px, height: px }}
      >
        <g fill="currentColor">
          <path d="M32 4 L29.5 14 L32 12 L34.5 14 Z" />
          <path d="M32 60 L29.5 50 L32 52 L34.5 50 Z" />
          <path d="M4 32 L14 29.5 L12 32 L14 34.5 Z" />
          <path d="M60 32 L50 29.5 L52 32 L50 34.5 Z" />
          {/* The peak, hollow (even-odd) so it reads on either theme's surface. */}
          <path fillRule="evenodd" d="M32 17 L45 41 L19 41 Z M32 26 L24 39.5 L40 39.5 Z" />
          <rect x="27" y="35" width="10" height="2" />
        </g>
        <circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" strokeWidth="3" />
      </svg>
    );
  }
  return (
    <img
      src="/logo.png"
      alt={alt}
      width={px}
      height={px}
      decoding="async"
      className={cn('rounded-md object-contain shrink-0', className)}
      style={{ width: px, height: px }}
    />
  );
}
