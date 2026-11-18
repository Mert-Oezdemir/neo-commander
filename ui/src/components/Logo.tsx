/** Neo Commander mark: an open signal ring with a command chevron and a live node. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="logo-mark">
      <rect width="32" height="32" rx="8" fill="#111A2B" />
      <path d="M16 6.5a9.5 9.5 0 1 0 9.2 11.9" fill="none" stroke="#9AA6FF" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="24.6" cy="9.6" r="2.6" fill="#5BE3B0" />
      <path d="M13.2 12.6 18 16l-4.8 3.4" fill="none" stroke="#F2F5FF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <LogoMark size={34} />
      <span className="wordmark-text">Neo Commander</span>
    </span>
  );
}
