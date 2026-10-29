import type { PnlPeriod, PnlWindow } from './types.js';

const dateParts = (time: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(time));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
};

function midnight(date: Date, timeZone: string): number {
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  let guess = target;
  for (let index = 0; index < 4; index++) {
    const parts = dateParts(guess, timeZone);
    const local = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const corrected = guess + target - local;
    if (corrected === guess) return guess;
    guess = corrected;
  }
  return guess;
}

export function pnlWindow(
  period: PnlPeriod,
  offset = 0,
  timeZone = 'UTC',
  now = Date.now(),
): PnlWindow {
  if (!Number.isInteger(offset) || offset < 0 || offset > 1200)
    throw new Error('Invalid PNL period');
  const local = dateParts(now, timeZone);
  const startDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (period === 'week')
    startDate.setUTCDate(startDate.getUTCDate() - ((startDate.getUTCDay() + 6) % 7) - offset * 7);
  else if (period === 'month') {
    startDate.setUTCDate(1);
    startDate.setUTCMonth(startDate.getUTCMonth() - offset);
  } else startDate.setUTCDate(startDate.getUTCDate() - offset);
  const endDate = new Date(startDate);
  if (period === 'month') endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  else endDate.setUTCDate(endDate.getUTCDate() + (period === 'week' ? 7 : 1));
  const start = midnight(startDate, timeZone);
  const end = midnight(endDate, timeZone);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const label =
    period === 'day'
      ? formatter.format(start)
      : period === 'month'
        ? new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'long' }).format(
            start,
          )
        : `${formatter.format(start)} - ${formatter.format(end - 1)}`;
  return { period, offset, start, end, label, timeZone };
}
