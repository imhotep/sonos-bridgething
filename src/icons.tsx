/** Filled transport icons (Material-style geometry), colored via currentColor. */

type IconProps = { size?: number };

export function IconPlay({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13c0 .9.97 1.44 1.72.94l10.1-6.5a1.1 1.1 0 0 0 0-1.88L9.72 4.56A1.1 1.1 0 0 0 8 5.5z" />
    </svg>
  );
}

export function IconPause({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5.5" y="4.5" width="4.6" height="15" rx="1.2" />
      <rect x="13.9" y="4.5" width="4.6" height="15" rx="1.2" />
    </svg>
  );
}

export function IconStop({ size = 22 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />
    </svg>
  );
}
