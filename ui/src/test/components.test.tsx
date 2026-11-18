import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorCard } from '../components/ConnectorCard';
import { ModeSelector } from '../components/ModeSelector';
import { SecurityPage } from '../pages/SecurityPage';
import { AppProvider, useApp } from '../state/store';
import { ToastProvider } from '../state/toast';
import { URL_FIXTURE, fakeServer } from './fixtures';

function Harness({ server, children }: { server: ReturnType<typeof fakeServer>; children: ReactNode }) {
  return <ToastProvider><AppProvider api={server.api} live={false}>{children}</AppProvider></ToastProvider>;
}
function Ready({ children }: { children: ReactNode }) {
  const { snapshot } = useApp();
  return snapshot ? <>{children}</> : <p>yükleniyor</p>;
}

describe('ConnectorCard', () => {
  it('copies the connector link and shows success feedback', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const server = fakeServer();
    const Card = () => { const { snapshot } = useApp(); return snapshot ? <ConnectorCard snapshot={snapshot} /> : null; };
    render(<Harness server={server}><Card /></Harness>);

    await screen.findByText(URL_FIXTURE);
    await user.click(screen.getByRole('button', { name: 'Linki kopyala' }));
    expect(writeText).toHaveBeenCalledWith(URL_FIXTURE);
    expect(await screen.findByRole('button', { name: 'Kopyalandı' })).toBeInTheDocument();
    expect(screen.getAllByText('Link kopyalandı').length).toBeGreaterThan(0);
  });

  it('hides the PIN until revealed and warns about quick tunnels', async () => {
    const user = userEvent.setup();
    const server = fakeServer();
    const Card = () => { const { snapshot } = useApp(); return snapshot ? <ConnectorCard snapshot={snapshot} /> : null; };
    render(<Harness server={server}><Card /></Harness>);
    await screen.findByText(URL_FIXTURE);
    expect(screen.queryByText('AAAA-BBBB-CCCC-DDDD')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Göster/ }));
    expect(screen.getByText('AAAA-BBBB-CCCC-DDDD')).toBeInTheDocument();
    expect(screen.getByText(/bilgisayar yeniden başlayınca değişir/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sabit link ayarlarına git/ })).toHaveAttribute('href', '#/ayarlar');
  });
});

describe('KillSwitch', () => {
  it('toggles pause through the API with the CSRF header and reflects the new state', async () => {
    const user = userEvent.setup();
    const server = fakeServer();
    render(<Harness server={server}><Ready><SecurityPage /></Ready></Harness>);

    const btn = await screen.findByRole('button', { name: /Acil durdur/ });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await user.click(btn); // confirm-less

    const post = server.calls.find((c) => c.method === 'POST' && c.url.endsWith('/settings'));
    expect(post).toBeDefined();
    expect(post!.body).toEqual({ paused: true });
    expect(post!.headers['x-neo-csrf']).toBe('tok-123');
    expect(await screen.findByRole('button', { name: /Devam et/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Her şey durduruldu')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Devam et/ }));
    await waitFor(() => expect(server.calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({ paused: false }));
  });
});

describe('ModeSelector', () => {
  it('changes mode via radio cards', async () => {
    const user = userEvent.setup();
    const server = fakeServer();
    render(<Harness server={server}><Ready><ModeSelector mode="standard" /></Ready></Harness>);
    const readonly = await screen.findByRole('radio', { name: /Salt okunur/ });
    expect(screen.getByRole('radio', { name: /Standart/ })).toBeChecked();
    await user.click(readonly);
    const post = server.calls.find((c) => c.method === 'POST');
    expect(post!.body).toEqual({ mode: 'readonly' });
  });
});
