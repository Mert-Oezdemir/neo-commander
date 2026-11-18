import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../lib/clipboard';
import { useToast } from '../state/toast';

interface Props {
  text: string;
  /** Visible label, e.g. "Linki kopyala". */
  label: string;
  /** Toast text on success, e.g. "Link kopyalandı". */
  doneToast: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  icon?: ReactNode;
}

export function CopyButton({ text, label, doneToast, variant = 'secondary', disabled, icon }: Props) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const toast = useToast();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    const ok = await copyText(text);
    if (!ok) { toast.push('error', 'Kopyalanamadı. Metni elle seçip kopyalayın.'); return; }
    setDone(true);
    toast.push('success', doneToast);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 2000);
  };

  return (
    <button type="button" className={`btn btn-${variant} ${done ? 'is-done' : ''}`} onClick={onClick} disabled={disabled}>
      {done ? <Check size={18} aria-hidden="true" /> : (icon ?? <Copy size={18} aria-hidden="true" />)}
      <span aria-live="polite">{done ? 'Kopyalandı' : label}</span>
    </button>
  );
}
