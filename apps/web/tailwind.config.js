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
      },
      fontFamily: {
        // Variable fonts loaded from @fontsource-variable/*. The "Variable"
        // suffix is the family name those packages register.
        display: ['"Cormorant Garamond Variable"', '"Cormorant Garamond"', 'Georgia', 'serif'],
        sans: ['"Geist Variable"', 'Geist', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
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
        'shimmer': {
          '100%': { transform: 'translateX(100%)' },
        },
        'splash-sweep': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-out': 'fade-out 0.15s ease-in',
        'zoom-in': 'zoom-in 0.18s ease-out',
        'zoom-out': 'zoom-out 0.15s ease-in',
        'slide-in-from-right': 'slide-in-from-right 0.25s ease-out',
        'slide-out-to-right': 'slide-out-to-right 0.2s ease-in',
        'shimmer': 'shimmer 1.6s infinite',
        'splash-sweep': 'splash-sweep 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
