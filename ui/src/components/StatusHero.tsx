import { Cpu, Globe, ShieldCheck } from 'lucide-react';
import type { Snapshot } from '../api/types';
import { deriveStatus, engineLine, MODE_LABEL, tunnelLine } from '../lib/status';
import { Beacon } from './Beacon';

export function StatusHero({ snapshot }: { snapshot: Snapshot }) {
  const st = deriveStatus(snapshot);
  return (
    <section className={`hero hero-${st.tone}`} aria-labelledby="hero-title">
      <Beacon tone={st.tone} />
      <div className="hero-body">
        <p className="hero-title" id="hero-title" role="status" aria-live="polite">{st.title}</p>
        <p className="hero-sub">{st.sub}</p>
        <dl className="hero-facts">
          <div><dt><Cpu size={15} aria-hidden="true" /> Motor</dt><dd>{engineLine(snapshot)}</dd></div>
          <div><dt><Globe size={15} aria-hidden="true" /> Bağlantı</dt><dd>{tunnelLine(snapshot)}</dd></div>
          <div><dt><ShieldCheck size={15} aria-hidden="true" /> Yetki</dt><dd>{MODE_LABEL[snapshot.mode]}</dd></div>
        </dl>
      </div>
    </section>
  );
}
