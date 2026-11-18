import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CopyButton } from './CopyButton';

interface Props { url: string | null }

type AgentKey = 'claude' | 'chatgpt' | 'gemini' | 'code';
const TABS: { key: AgentKey; label: string }[] = [
  { key: 'claude', label: 'Claude' },
  { key: 'chatgpt', label: 'ChatGPT' },
  { key: 'gemini', label: 'Gemini CLI' },
  { key: 'code', label: 'Claude Code / Cursor' },
];

function Steps({ children }: { children: ReactNode }) { return <ol className="steps">{children}</ol>; }
function Path({ items }: { items: string[] }) {
  return <>{items.map((p, i) => <span key={p}>{i > 0 && <span className="path-sep" aria-hidden="true"> › </span>}<b>{p}</b></span>)}</>;
}

function Snippet({ code, label, doneToast }: { code: string; label: string; doneToast: string }) {
  return (
    <div className="snippet">
      <pre tabIndex={0} aria-label={label}><code>{code}</code></pre>
      <CopyButton text={code} label="Kopyala" doneToast={doneToast} variant="secondary" />
    </div>
  );
}

export function AgentGuides({ url }: Props) {
  const [active, setActive] = useState<AgentKey>('claude');
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const link = url ?? 'https://…/mcp';

  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.key === active);
    let n = i;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    else return;
    e.preventDefault();
    const next = TABS[n]!;
    setActive(next.key);
    refs.current[next.key]?.focus();
  };

  const geminiJson = `{\n  "mcpServers": {\n    "neo": {\n      "httpUrl": "${link}"\n    }\n  }\n}`;
  const codeCmd = `claude mcp add --transport http neo ${link}`;

  return (
    <section className="card" aria-labelledby={`${base}-t`}>
      <h2 id={`${base}-t`} className="card-title">Yapay zekaya nasıl eklenir?</h2>
      <div className="tabs" role="tablist" aria-label="Yapay zeka uygulaması" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => { refs.current[t.key] = el; }}
            role="tab"
            type="button"
            id={`${base}-tab-${t.key}`}
            aria-selected={active === t.key}
            aria-controls={`${base}-panel-${t.key}`}
            tabIndex={active === t.key ? 0 : -1}
            className={`tab ${active === t.key ? 'is-on' : ''}`}
            onClick={() => setActive(t.key)}
          >{t.label}</button>
        ))}
      </div>

      <div role="tabpanel" id={`${base}-panel-${active}`} aria-labelledby={`${base}-tab-${active}`} className="tabpanel">
        {active === 'claude' && (
          <Steps>
            <li>Claude’u açın ve <Path items={['Ayarlar', 'Bağlayıcılar', 'Özel bağlayıcı ekle']} /> yolunu izleyin.</li>
            <li>Yukarıdaki <b>bağlayıcı linkini</b> yapıştırıp ekleyin.</li>
            <li>Açılan sayfada <b>sahip PIN’ini</b> girin ve izin verin.</li>
          </Steps>
        )}
        {active === 'chatgpt' && (
          <>
            <Steps>
              <li>ChatGPT’yi açın ve <Path items={['Ayarlar', 'Uygulamalar', 'Gelişmiş ayarlar', 'Geliştirici modu']} /> yolunu izleyin. Bazı hesaplarda “Uygulamalar” yerine “Bağlayıcılar” yazar.</li>
              <li>Geliştirici modunu açın ve <b>Oluştur</b>’a basın.</li>
              <li>Yukarıdaki <b>bağlayıcı linkini</b> girin, kimlik doğrulama olarak OAuth’u seçin ve kaydedin.</li>
              <li>Açılan sayfada <b>sahip PIN’ini</b> girin ve izin verin.</li>
            </Steps>
            <p className="field-hint">Geliştirici modu için ChatGPT Plus veya Pro gerekir.</p>
          </>
        )}
        {active === 'gemini' && (
          <>
            <Steps>
              <li>Gemini CLI’ın <b>settings.json</b> dosyasını açın (<code>~/.gemini/settings.json</code>).</li>
              <li>Aşağıdaki bölümü ekleyin.</li>
              <li>Gemini CLI’ı yeniden başlatın. İlk kullanımda açılan sayfada <b>sahip PIN’ini</b> girin.</li>
            </Steps>
            <Snippet code={geminiJson} label="Gemini CLI ayarı" doneToast="Ayar kopyalandı" />
          </>
        )}
        {active === 'code' && (
          <>
            <Steps>
              <li>Terminalde aşağıdaki komutu çalıştırın. Cursor’da aynı linki MCP ayarlarına <b>url</b> olarak ekleyin.</li>
              <li>İlk kullanımda açılan sayfada <b>sahip PIN’ini</b> girin ve izin verin.</li>
            </Steps>
            <Snippet code={codeCmd} label="Claude Code komutu" doneToast="Komut kopyalandı" />
          </>
        )}
        {!url && <p className="field-hint">Link hazır olunca bu adımlardaki örnekler otomatik dolar.</p>}
      </div>
    </section>
  );
}
