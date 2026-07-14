import type { SVGProps } from 'react';

export type PublicIconName =
  | 'arrowRight'
  | 'calendar'
  | 'category'
  | 'chart'
  | 'check'
  | 'chevronLeft'
  | 'chevronRight'
  | 'close'
  | 'compare'
  | 'external'
  | 'filter'
  | 'image'
  | 'link'
  | 'menu'
  | 'price'
  | 'search'
  | 'shield'
  | 'source'
  | 'tag'
  | 'warning';

const paths: Record<PublicIconName, string[]> = {
  arrowRight: ['M5 12h14', 'm13-6 6 6-6 6'],
  calendar: ['M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z', 'M8 2v4M16 2v4M3 10h18'],
  category: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'],
  chart: ['M4 19V5', 'M4 19h16', 'm7 15 3-4 3 2 5-7'],
  check: ['m5 12 4 4L19 6'],
  chevronLeft: ['m15 18-6-6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  close: ['M6 6l12 12M18 6 6 18'],
  compare: ['M8 4v16M16 4v16', 'M4 8h8M12 16h8', 'm4 8 2-2m-2 2 2 2', 'm16 16-2-2m2 2-2 2'],
  external: ['M14 4h6v6M20 4l-9 9', 'M18 13v6H5V6h6'],
  filter: ['M4 5h16l-6 7v6l-4 2v-8L4 5Z'],
  image: ['M4 5h16v14H4z', 'm4 15 4-4 3 3 3-3 4 4', 'M9 9h.01'],
  link: ['M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1', 'M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  price: ['M12 3v18', 'M16 7.5c-.8-1-2-1.5-4-1.5-2.2 0-4 1.2-4 3s1.8 3 4 3 4 1.2 4 3-1.8 3-4 3c-2 0-3.2-.5-4-1.5'],
  search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z', 'm16 16 5 5'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'm9 12 2 2 4-4'],
  source: ['M12 3a9 9 0 1 0 9 9', 'M3.6 9h12.8M3.6 15h9.8', 'M17 3v6h4'],
  tag: ['M20 13 13 20 4 11V4h7l9 9Z', 'M8.5 8.5h.01'],
  warning: ['M12 3 2.8 20h18.4L12 3Z', 'M12 9v5M12 17h.01'],
};

export function PublicIcon({
  name,
  size = 18,
  ...props
}: {
  name: PublicIconName;
  size?: number;
} & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths[name].map((path, index) => <path d={path} key={`${name}-${index}`} />)}
    </svg>
  );
}
