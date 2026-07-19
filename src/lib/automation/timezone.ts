export const AUTOMATION_TIMEZONE = 'Asia/Ho_Chi_Minh' as const;

const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: AUTOMATION_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function vietnamDayKey(value: number | Date = Date.now()): string {
  const parts = DAY_FORMATTER.formatToParts(value instanceof Date ? value : new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function startOfVietnamDay(value: number | Date = Date.now()): number {
  return Date.parse(`${vietnamDayKey(value)}T00:00:00+07:00`);
}

export function formatVietnamDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Không xác định';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: AUTOMATION_TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

export function vietnamTimeParts(value: number | Date = Date.now()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: AUTOMATION_TIMEZONE,
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value || 0);
  return { hour: part('hour'), minute: part('minute') };
}

export function vietnamActivityLabel(value: string | number | Date, hourly: boolean): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'N/A';
  return new Intl.DateTimeFormat('en-GB', hourly
    ? { timeZone: AUTOMATION_TIMEZONE, hour: '2-digit', hourCycle: 'h23' }
    : { timeZone: AUTOMATION_TIMEZONE, day: '2-digit', month: '2-digit' }).format(date) + (hourly ? ':00' : '');
}
