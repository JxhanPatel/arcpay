import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';

const ThemeContext = createContext<
  {
    theme: 'light' | 'dark';
    toggleTheme: () => void;
    setTheme: (theme: 'light' | 'dark') => void;
  } | undefined
>(undefined);

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => {
    return (document.documentElement.dataset.theme as 'light' | 'dark') || 'light';
  });

  const applyTheme = (next: 'light' | 'dark') => {
    document.documentElement.dataset.theme = next;
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (meta) {
      meta.setAttribute('content', next === 'dark' ? '#0A0810' : '#F7F5FB');
    }
  };

  const setPersistedTheme = (next: 'light' | 'dark') => {
    applyTheme(next);
    try {
      localStorage.setItem('arc_theme', next);
    } catch {
      // ignore
    }
  };

  // If the user hasn't chosen a theme, follow system preference live.
  useEffect(() => {
    const stored = localStorage.getItem('arc_theme');
    if (stored) return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setPersistedTheme(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setPersistedTheme(next);
    setThemeState(next);
  };

  const setTheme = (next: 'light' | 'dark') => {
    setPersistedTheme(next);
    setThemeState(next);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
};

export default ThemeProvider;