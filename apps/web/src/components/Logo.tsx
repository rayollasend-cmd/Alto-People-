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

export function Logo({ size = 'sm', className, alt = 'Alto HR' }: LogoProps) {
  const px = SIZE_PX[size];
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
