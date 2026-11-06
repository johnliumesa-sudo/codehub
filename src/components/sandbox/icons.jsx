// Inline SVG icons shared by the sandbox (preview) and games (arcade) modules.
const P = {
  play: 'M7 4.5v15l12-7.5-12-7.5Z',
  stop: 'M6 6h12v12H6z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  close: 'M6 6l12 12M18 6 6 18',
  terminal: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  gamepad: 'M7 8h10a5 5 0 0 1 4.8 6.4l-.6 2.2a2.5 2.5 0 0 1-4.3 1L15 15.5H9l-1.9 2.1a2.5 2.5 0 0 1-4.3-1l-.6-2.2A5 5 0 0 1 7 8ZM8 10.5v3M6.5 12h3M15.5 11h.01M17.5 13h.01',
  heart: 'M12 20s-7.5-4.6-9.2-9.4C1.6 7.2 3.9 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.3 0 5.6 3.2 4.4 6.6C19.5 15.4 12 20 12 20Z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  alert: 'M12 3 2 20h20L12 3ZM12 10v4M12 17h.01',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-5-5',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5',
  check: 'm5 12 5 5 9-10',
  menu: 'M4 6h16M4 12h16M4 18h16',
};

export function Icon({ name, size = 16, className = '', title, fill = 'none' }) {
  return (
    <svg
      className={`sbx-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={P[name] || P.file} />
    </svg>
  );
}
