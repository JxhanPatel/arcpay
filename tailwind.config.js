/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: '#050505',
        surface: '#121212',
        edge: '#27272A',
        accent: '#3B82F6',
        text: '#FAFAFA',
        muted: '#A1A1AA',
        silver: '#E4E4E7'
      },
      boxShadow: {
        glow: '0 0 60px rgba(59, 130, 246, 0.18)'
      }
    }
  },
  plugins: []
};
