/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* Backgrounds */
        'bg-base': '#08090D',
        'bg-surface': '#111216',
        'bg-elevated': '#16171C',
        /* Borders */
        'border-subtle': 'rgba(255,255,255,0.08)',
        'border-strong': 'rgba(255,255,255,0.12)',
        /* Text */
        'text-primary': '#F5F3FF',
        'text-secondary': '#A1A1AA',
        'text-tertiary': '#71717A',
        /* Purple accent */
        'accent': '#8B5CF6',
        'accent-hover': '#A78BFA',
        'accent-deep': '#6D28D9',
        'accent-active': '#7C3AED',
        /* Legacy aliases kept for incremental migration */
        obsidian: '#08090D',
        surface: '#111216',
        edge: 'rgba(255,255,255,0.08)',
        text: '#F5F3FF',
        muted: '#A1A1AA',
        silver: '#E4E4E7',
      },
      boxShadow: {
        'glow': '0 0 24px rgba(139, 92, 246, 0.20)',
        'glow-lg': '0 0 48px rgba(139, 92, 246, 0.15)',
        'scan': '0 0 20px rgba(139, 92, 246, 0.30), 0 4px 12px rgba(0,0,0,0.4)',
        'scan-hover': '0 0 28px rgba(139, 92, 246, 0.40), 0 6px 16px rgba(0,0,0,0.5)',
        'subtle': '0 1px 3px rgba(0,0,0,0.3)',
      },
      borderRadius: {
        'surface': '16px',
        'card': '14px',
      },
      transitionDuration: {
        'fast': '150ms',
        'normal': '200ms',
      },
    }
  },
  plugins: []
};
