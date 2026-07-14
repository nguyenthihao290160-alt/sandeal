import type { SVGProps } from 'react';

export type DashboardIconName =
  | 'dashboard' | 'product' | 'task' | 'queue' | 'approval' | 'ai' | 'worker'
  | 'scheduler' | 'security' | 'health' | 'settings' | 'emergency' | 'refresh'
  | 'check' | 'warning' | 'source' | 'filter' | 'grid' | 'list' | 'lock'
  | 'menu' | 'close' | 'chevronDown' | 'chevronRight' | 'external' | 'tools' | 'content'
  | 'import' | 'duplicate' | 'price' | 'analytics' | 'alert' | 'today' | 'calendar'
  | 'compare' | 'search';

const paths: Record<DashboardIconName, string[]> = {
  dashboard: ['M4 4h6v6H4z', 'M14 4h6v10h-6z', 'M4 14h6v6H4z', 'M14 18h6v2h-6z'],
  product: ['M20 7l-8-4-8 4 8 4 8-4Z', 'M4 7v10l8 4 8-4V7', 'M12 11v10'],
  task: ['M9 11l2 2 4-4', 'M5 4h14v16H5z', 'M8 2v4M16 2v4'],
  queue: ['M4 6h16', 'M4 12h16', 'M4 18h10'],
  approval: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'M9 12l2 2 4-4'],
  ai: ['M12 3v3M12 18v3M3 12h3M18 12h3', 'M7.5 7.5l2.2 9h4.6l2.2-9', 'M8.4 13h7.2'],
  worker: ['M8 9h8v8H8z', 'M12 2v3M12 19v3M2 12h3M19 12h3', 'M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2'],
  scheduler: ['M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z', 'M8 2v4M16 2v4M3 10h18', 'M12 13v3l2 1'],
  security: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'M9 11h6v5H9z', 'M10 11V9a2 2 0 0 1 4 0v2'],
  health: ['M3 12h4l2-6 4 12 2-6h6'],
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M4.9 4.9l2 2M17.1 17.1l2 2M2 12h3M19 12h3M4.9 19.1l2-2M17.1 6.9l2-2M12 2v3M12 19v3'],
  emergency: ['M12 3 2.8 20h18.4L12 3Z', 'M12 9v5M12 17h.01'],
  refresh: ['M20 6v5h-5', 'M4 18v-5h5', 'M18.5 9A7 7 0 0 0 6 6.5L4 11M5.5 15A7 7 0 0 0 18 17.5l2-4.5'],
  check: ['M5 12l4 4L19 6'],
  warning: ['M12 3 2.8 20h18.4L12 3Z', 'M12 9v5M12 17h.01'],
  source: ['M12 3a9 9 0 1 0 9 9', 'M3.6 9h12.8M3.6 15h9.8', 'M17 3v6h4'],
  filter: ['M4 5h16l-6 7v6l-4 2v-8L4 5Z'],
  grid: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'],
  list: ['M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'],
  lock: ['M7 10h10v10H7z', 'M9 10V7a3 3 0 0 1 6 0v3'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  close: ['M6 6l12 12M18 6 6 18'],
  chevronDown: ['M7 9l5 5 5-5'],
  chevronRight: ['M9 7l5 5-5 5'],
  external: ['M14 4h6v6M20 4l-9 9', 'M18 13v6H5V6h6'],
  tools: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z'],
  content: ['M6 3h9l4 4v14H6z', 'M15 3v5h5M9 12h7M9 16h7'],
  import: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  duplicate: ['M8 8h11v11H8z', 'M5 16H3V3h13v2'],
  price: ['M4 5h16v14H4z', 'M8 9h8M8 13h5M8 17h8'],
  analytics: ['M4 19V9M10 19V5M16 19v-7M22 19H2'],
  alert: ['M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6Z', 'M10 20h4'],
  today: ['M5 4h14v16H5z', 'M8 2v4M16 2v4M5 9h14', 'M9 14l2 2 4-4'],
  calendar: ['M5 4h14v16H5z', 'M8 2v4M16 2v4M5 9h14'],
  compare: ['M8 4 4 8l4 4M4 8h9', 'M16 12l4 4-4 4M20 16h-9'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'M16 16l5 5'],
};

export function DashboardIcon({ name, size = 18, ...props }: { name: DashboardIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
    {paths[name].map((path, index) => <path d={path} key={`${name}-${index}`} />)}
  </svg>;
}
