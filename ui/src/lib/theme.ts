export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'neo-theme';

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* storage blocked */ }
  return 'system';
}

export function saveThemePref(p: ThemePref): void {
  try { localStorage.setItem(KEY, p); } catch { /* storage blocked */ }
}

export function resolveTheme(p: ThemePref): 'light' | 'dark' {
  if (p !== 'system') return p;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(p: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(p);
}
