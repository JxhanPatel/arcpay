/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* Semantic tokens mapped to theme-aware CSS variables (RGB channels) */
        bg: 'rgb(var(--bg) / <alpha-value>)',
        elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-2': 'rgb(var(--ink-2) / <alpha-value>)',
        'ink-3': 'rgb(var(--ink-3) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        positive: 'rgb(var(--positive) / <alpha-value>)',
        negative: 'rgb(var(--negative) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Outfit', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        display: ['Newsreader', 'Georgia', 'serif'],
      },
      boxShadow: {
        /* Glow/shadow decorations removed per design plan Phase 1–3 */
        'subtle': '0 1px 3px rgba(0,0,0,0.3)',
      },
      borderRadius: {
        'surface': '16px',
        'card': '14px',
      },
      transitionDuration: {
        'fast': '150ms',
        'normal': '200ms',
        '180': '180ms',
      },
      scale: {
        '98': '0.98',
      },
    }
  },
  plugins: []
};
