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
        'accent-text': 'rgb(var(--accent-text) / <alpha-value>)',
        positive: 'rgb(var(--positive) / <alpha-value>)',
        negative: 'rgb(var(--negative) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Outfit', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        display: ['Newsreader', 'Georgia', 'serif'],
      },
      boxShadow: {
        'glow': '0 0 40px rgb(var(--accent) / 0.35)',
        'glow-lg': '0 0 48px rgb(var(--accent) / 0.15)',
        'scan': '0 0 20px rgb(var(--accent) / 0.30), 0 4px 12px rgba(0,0,0,0.4)',
        'scan-hover': '0 0 28px rgb(var(--accent) / 0.40), 0 6px 16px rgba(0,0,0,0.5)',
        'subtle': '0 1px 3px rgba(0,0,0,0.3)',
        float: 'var(--shadow-float)',
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
