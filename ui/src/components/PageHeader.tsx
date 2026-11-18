import { useEffect, useRef, type ReactNode } from 'react';

/** Page title; receives focus on route change so keyboard and screen-reader users land at the top. */
export function PageHeader({ title, lead, actions }: { title: string; lead?: string; actions?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  // Only when the user arrived via the nav: keyboard / screen-reader users land at the top of the new page.
  useEffect(() => { if (document.activeElement?.closest('.nav')) ref.current?.focus({ preventScroll: true }); }, []);
  return (
    <header className="page-head">
      <div>
        <h1 ref={ref} tabIndex={-1} className="page-title">{title}</h1>
        {lead && <p className="page-lead">{lead}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
