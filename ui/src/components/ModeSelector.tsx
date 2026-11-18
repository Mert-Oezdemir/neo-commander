import { Eye, Layers, Zap } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import type { Mode } from '../api/types';
import { MODE_LABEL } from '../lib/status';
import { useApp } from '../state/store';

const MODES: { value: Mode; Icon: typeof Zap; text: string }[] = [
  { value: 'full', Icon: Zap, text: 'Dosyaları okur ve değiştirir, komut çalıştırır, fareyi ve klavyeyi kullanır.' },
  { value: 'standard', Icon: Layers, text: 'Dosyaları okur ve değiştirir, komut çalıştırır; fareyi ve klavyeyi kullanamaz.' },
  { value: 'readonly', Icon: Eye, text: 'Yalnızca bakar: dosyaları okur, arar, ekran görüntüsü alır; hiçbir şeyi değiştiremez.' },
];

export function ModeSelector({ mode }: { mode: Mode }) {
  const app = useApp();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const choose = (m: Mode) => { if (m !== mode) void app.updateSettings({ mode: m }, { success: `Yetki seviyesi: ${MODE_LABEL[m]}` }); };

  const onKey = (e: KeyboardEvent) => {
    const i = MODES.findIndex((m) => m.value === mode);
    let n = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % MODES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + MODES.length) % MODES.length;
    else return;
    e.preventDefault();
    const next = MODES[n]!;
    refs.current[next.value]?.focus();
    choose(next.value);
  };

  return (
    <section className="card" aria-labelledby="mode-title">
      <h2 id="mode-title" className="card-title">Yetki seviyesi</h2>
      <p className="card-lead">Yapay zekanın bu bilgisayarda neler yapabileceğini siz belirlersiniz.</p>
      <div className="mode-grid" role="radiogroup" aria-labelledby="mode-title" onKeyDown={onKey}>
        {MODES.map(({ value, Icon, text }) => (
          <button
            key={value}
            ref={(el) => { refs.current[value] = el; }}
            type="button"
            role="radio"
            aria-checked={mode === value}
            tabIndex={mode === value ? 0 : -1}
            className={`mode-card mode-${value} ${mode === value ? 'is-on' : ''}`}
            onClick={() => choose(value)}
          >
            <span className="mode-icon"><Icon size={22} aria-hidden="true" /></span>
            <span className="mode-name">{MODE_LABEL[value]}</span>
            <span className="mode-text">{text}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
