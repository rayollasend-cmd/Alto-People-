/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: 'rgb(var(--color-navy) / <alpha-value>)',
          secondary: 'rgb(var(--color-navy-secondary) / <alpha-value>)',
        },
        midnight: 'rgb(var(--color-midnight) / <alpha-value>)',
        gold: {
          DEFAULT: 'rgb(var(--color-gold) / <alpha-value>)',
          bright: 'rgb(var(--color-gold-bright) / <alpha-value>)',
        },
        silver: 'rgb(var(--color-silver) / <alpha-value>)',
        steel: 'rgb(var(--color-steel) / <alpha-value>)',
        sky: 'rgb(var(--color-sky) / <alpha-value>)',
        teal: 'rgb(var(--color-teal) / <alpha-value>)',
        alert: 'rgb(var(--color-alert) / <alpha-value>)',
        success: 'rgb(var(--color-success) / <alpha-value>)',
        warning: 'rgb(var(--color-warning) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        // Theme-STABLE text colors for use on colored fills. `text-navy` /
        // `text-white` flip meaning in light mode (the vars are remapped),
        // which made the primary gold button render white-on-gold there.
        // These two never flip: on-accent = dark ink on gold, on-solid =
        // white on saturated fills (alert/steel/success).
        'on-accent': 'rgb(var(--color-on-accent) / <alpha-value>)',
        'on-solid': 'rgb(var(--color-on-solid) / <alpha-value>)',
      },
      fontFamily: {
        // Variable fonts loaded from @fontsource-variable/*. The "Variable"
        // suffix is the family name those packages register.
        display: ['"Cormorant Garamond Variable"', '"Cormorant Garamond"', 'Georgia', 'serif'],
        sans: ['"Geist Variable"', 'Geist', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        // Map font-serif to the brand face so a stray `font-serif` (the
        // kiosk clock rendered in Georgia for months) can never fall
        // through to the platform serif again.
        serif: ['"Cormorant Garamond Variable"', '"Cormorant Garamond"', 'Georgia', 'serif'],
      },
      fontSize: {
        // The micro tier the app actually uses — previously 585 arbitrary
        // values (text-[10px] ×299, text-[11px] ×266...). Tokenized so the
        // whole tier can be retuned globally.
        '3xs': ['0.5625rem', { lineHeight: '0.875rem' }], // 9px
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }], // 10px — eyebrow/micro-label
        'xs2': ['0.6875rem', { lineHeight: '1rem' }], // 11px — meta/caption
        hero: ['2rem', { lineHeight: '1.1', letterSpacing: '-0.02em' }],
        'hero-lg': ['2.5rem', { lineHeight: '1.1', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        // Bare `rounded` (4px) was a fourth, off-system radius used 184
        // times next to the kit's 6px controls. Alias it to md so legacy
        // and future bare `rounded` land on-system.
        DEFAULT: '0.375rem',
      },
      ringOffsetColor: {
        DEFAULT: 'rgb(var(--color-navy))',
      },
      ringOffsetWidth: {
        DEFAULT: '2px',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-out': {
          from: { opacity: '1' },
          to: { opacity: '0' },
        },
        'zoom-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'zoom-out': {
          from: { opacity: '1', transform: 'scale(1)' },
          to: { opacity: '0', transform: 'scale(0.96)' },
        },
        'slide-in-from-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'slide-out-to-right': {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(100%)' },
        },
        // Bottom-sheet dialogs on phones.
        'slide-up-in': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'slide-down-out': {
          from: { transform: 'translateY(0)' },
          to: { transform: 'translateY(100%)' },
        },
        'shimmer': {
          '100%': { transform: 'translateX(100%)' },
        },
        'splash-sweep': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        // Open / close timings harmonised so the modal, drawer, and
        // dropdown surfaces feel like one motion system. Open durations
        // are slightly longer than close (0.22 vs 0.18) — a "land
        // softly, depart quickly" cadence — and all use the same
        // cubic-bezier ease so the curvature reads identical across
        // surfaces. Dropdown / popover stay shorter (0.15) because
        // they're contextual flicks, not page-level transitions.
        'accordion-down': 'accordion-down 0.2s cubic-bezier(0.16,1,0.3,1)',
        'accordion-up': 'accordion-up 0.18s cubic-bezier(0.4,0,1,1)',
        'fade-in': 'fade-in 0.22s cubic-bezier(0.16,1,0.3,1)',
        'fade-out': 'fade-out 0.18s cubic-bezier(0.4,0,1,1)',
        'zoom-in': 'zoom-in 0.22s cubic-bezier(0.16,1,0.3,1)',
        'zoom-out': 'zoom-out 0.18s cubic-bezier(0.4,0,1,1)',
        'slide-in-from-right': 'slide-in-from-right 0.22s cubic-bezier(0.16,1,0.3,1)',
        'slide-out-to-right': 'slide-out-to-right 0.18s cubic-bezier(0.4,0,1,1)',
        'slide-up-in': 'slide-up-in 0.26s cubic-bezier(0.16,1,0.3,1)',
        'slide-down-out': 'slide-down-out 0.2s cubic-bezier(0.4,0,1,1)',
        'shimmer': 'shimmer 1.6s infinite',
        'splash-sweep': 'splash-sweep 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
    // Pointer-type variants. Touch affordances (44px targets, 16px form
    // text) must key on the INPUT DEVICE, not viewport width — an iPad is
    // 768-1194px wide (desktop breakpoints) but every tap is a finger.
    // Pattern: compact base + `coarse:` up-size. Never use `md:`/`sm:` to
    // shrink a touch concession.
    require('tailwindcss/plugin')(({ addVariant }) => {
      addVariant('coarse', '@media (pointer: coarse)');
      addVariant('fine', '@media (pointer: fine)');
      addVariant('can-hover', '@media (hover: hover)');
    }),
  ],
};
