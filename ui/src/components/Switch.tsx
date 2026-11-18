interface Props {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, hint, disabled }: Props) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className="switch-row" onClick={() => onChange(!checked)}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </button>
  );
}
