import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../../theme/ThemeProvider';

/**
 * ThemeToggle - A 44×44 circular glass button that toggles between light and dark themes.
 * Props: none
 * Uses a 200ms rotate+fade crossfade for the icon transition.
 */
export const ThemeToggle = () => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={isDark}
      onClick={toggleTheme}
      className="relative flex h-11 w-11 items-center justify-center rounded-full glass press-effect focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg transition-normal"
    >
      <Sun
        className={`absolute transition-all duration-200 ${
          isDark ? 'rotate-90 opacity-0' : 'rotate-0 opacity-100'
        }`}
      />
      <Moon
        className={`absolute transition-all duration-200 ${
          isDark ? 'rotate-0 opacity-100' : '-rotate-90 opacity-0'
        }`}
      />
    </button>
  );
};

export default ThemeToggle;