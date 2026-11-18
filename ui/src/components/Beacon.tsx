export type BeaconTone = 'ready' | 'starting' | 'paused' | 'error';

/** Concentric status mark; mirrors the logo ring. Animation lives in CSS and honours reduced motion. */
export function Beacon({ tone }: { tone: BeaconTone }) {
  return (
    <svg className={`beacon beacon-${tone}`} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <circle className="beacon-halo" cx="60" cy="60" r="52" />
      <circle className="beacon-ring" cx="60" cy="60" r="40" />
      <path className="beacon-arc" d="M60 20a40 40 0 1 0 38.7 50" />
      {tone === 'paused' ? (
        <g className="beacon-glyph"><rect x="48" y="46" width="8" height="28" rx="3" /><rect x="64" y="46" width="8" height="28" rx="3" /></g>
      ) : tone === 'error' ? (
        <g className="beacon-glyph"><rect x="56.5" y="44" width="7" height="20" rx="3" /><circle cx="60" cy="74" r="4" /></g>
      ) : (
        <path className="beacon-chevron" d="M53 47.5 69 60 53 72.5" />
      )}
      <circle className="beacon-node" cx="96" cy="31" r="7" />
    </svg>
  );
}
