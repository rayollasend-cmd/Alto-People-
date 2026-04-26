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
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
      },
      fontFamily: {
        display: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        sans: ['Montserrat', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
