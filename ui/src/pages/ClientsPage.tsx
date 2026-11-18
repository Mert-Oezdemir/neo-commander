import { Plug, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import type { ClientInfo } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import { formatDateTime, formatRelative, initials } from '../lib/format';
import { useNow } from '../state/hooks';
import { useApp } from '../state/store';

export function ClientsPage() {
  const { snapshot, revokeClient, revokeAll } = useApp();
  const now = useNow(30_000);
  const [target, setTarget] = useState<ClientInfo | null>(null);
  const [all, setAll] = useState(false);
  if (!snapshot) return null;
  const clients = snapshot.clients;

  return (
    <>
      <PageHeader
        title="Bağlantılar"
        lead="Bu bilgisayara bağlanma izni verdiğiniz yapay zeka uygulamaları."
        actions={clients.length > 0 && (
          <button type="button" className="btn btn-danger-quiet" onClick={() => setAll(true)}><ShieldOff size={18} aria-hidden="true" /> Tümünü iptal et</button>
        )}
      />
      <section className="card" aria-label="Bağlı uygulamalar">
        {clients.length === 0 ? (
          <div className="empty">
            <Plug size={28} aria-hidden="true" />
            <p className="empty-title">Henüz bağlı uygulama yok</p>
            <p>Claude veya ChatGPT’yi eklemek için Bağlan sayfasındaki adımları izleyin.</p>
            <a className="btn btn-primary" href="#/baglan">Bağlan sayfasına git</a>
          </div>
        ) : (
          <ul className="client-list">
            {clients.map((c) => (
              <li key={c.clientId} className="client">
                <span className="avatar" aria-hidden="true">{initials(c.clientName || '?')}</span>
                <div className="client-info">
                  <p className="client-name">{c.clientName || 'Adsız istemci'}</p>
                  <p className="client-meta">
                    <span>Eklendi: {formatDateTime(c.createdAt)}</span>
                    <span>{c.lastUsedAt ? `Son kullanım: ${formatRelative(c.lastUsedAt, now)}` : 'Henüz kullanılmadı'}</span>
                  </p>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTarget(c)} aria-label={`${c.clientName || 'İstemci'} erişimini iptal et`}>Erişimi iptal et</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={target !== null}
        title={`${target?.clientName || 'Bu uygulama'} erişimi iptal edilsin mi?`}
        body="Uygulama bu bilgisayara artık bağlanamaz. Tekrar bağlanmak isterse PIN’i yeniden girmesi gerekir."
        confirmLabel="Erişimi iptal et"
        tone="danger"
        onCancel={() => setTarget(null)}
        onConfirm={() => { const id = target?.clientId; setTarget(null); if (id) void revokeClient(id); }}
      />
      <ConfirmDialog
        open={all}
        title="Tüm erişimler iptal edilsin mi?"
        body={`${clients.length} uygulamanın bağlantısı kesilir. Hepsi yeniden bağlanırken PIN’i girmek zorunda kalır.`}
        confirmLabel="Tümünü iptal et"
        tone="danger"
        onCancel={() => setAll(false)}
        onConfirm={() => { setAll(false); void revokeAll(); }}
      />
    </>
  );
}
