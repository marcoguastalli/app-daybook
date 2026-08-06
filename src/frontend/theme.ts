import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const STORAGE_KEY = "daybook-theme";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function effectiveTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : systemTheme();
}

export function initTheme(): void {
  document.documentElement.dataset.theme = effectiveTheme();
}

/** Defaults to the system preference; an explicit toggle is persisted. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(effectiveTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    setTheme(next);
  };
  return [theme, toggle];
}
