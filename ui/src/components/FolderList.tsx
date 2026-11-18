import { Folder, FolderPlus, TriangleAlert, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { validateDirectory } from '../lib/format';
import { useApp } from '../state/store';

export function FolderList({ dirs }: { dirs: string[] }) {
  const app = useApp();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const err = validateDirectory(value);
    if (err) { setError(err); return; }
    if (dirs.includes(value.trim())) { setError('Bu klasör zaten listede.'); return; }
    setError(null);
    setBusy(true);
    const ok = await app.updateSettings({ addDirectory: value.trim() }, { success: 'Klasör eklendi' });
    setBusy(false);
    if (ok) setValue('');
  };

  return (
    <section className="card" aria-labelledby="dirs-title">
      <h2 id="dirs-title" className="card-title">İzinli klasörler</h2>
      <p className="card-lead">Yapay zeka yalnızca bu klasörlerdeki dosyalara dokunabilir.</p>

      {dirs.length === 0 ? (
        <div className="notice notice-warn">
          <TriangleAlert size={18} aria-hidden="true" />
          <p>Klasör kısıtı yok. Yapay zeka bilgisayarınızdaki tüm dosyalara erişebilir. Güvenli olması için bir klasör ekleyin.</p>
        </div>
      ) : (
        <ul className="dir-list">
          {dirs.map((d) => (
            <li key={d}>
              <Folder size={18} aria-hidden="true" />
              <span className="dir-path">{d}</span>
              <button type="button" className="icon-btn" aria-label={`${d} klasörünü kaldır`} onClick={() => void app.updateSettings({ removeDirectory: d }, { success: 'Klasör kaldırıldı' })}>
                <X size={18} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="dir-form" onSubmit={(e) => void submit(e)} noValidate>
        <label className="field-label" htmlFor="dir-input">Klasör ekle</label>
        <div className="copy-row">
          <input
            id="dir-input"
            className="input"
            type="text"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            placeholder="C:\Users\Adınız\Belgeler"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
          />
          <button type="submit" className="btn btn-secondary" disabled={busy}><FolderPlus size={18} aria-hidden="true" /> Ekle</button>
        </div>
        {error && <p id={errId} className="field-error" role="alert">{error}</p>}
      </form>
    </section>
  );
}
