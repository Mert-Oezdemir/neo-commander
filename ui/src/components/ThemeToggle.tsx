import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { applyTheme, loadThemePref, saveThemePref, type ThemePref } from '../lib/theme';

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: 'system', label: 'Sistem teması', Icon: Monitor },
  { value: 'light', label: 'Açık tema', Icon: Sun },
  { value: 'dark', label: 'Koyu tema', Icon: Moon },
];

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(loadThemePref);

  useEffect(() => {
    applyTheme(pref);
    if (pref !== 'system' || typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [pref]);

  const choose = (p: ThemePref) => { setPref(p); saveThemePref(p); };

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Tema">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={pref === value}
          aria-label={label}
          title={label}
          className={`theme-opt ${pref === value ? 'is-on' : ''}`}
          onClick={() => choose(value)}
        >
          <Icon size={16} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
