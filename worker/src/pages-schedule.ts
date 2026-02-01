export type PagesSchedule = {
  monthKey: string;
  dayCount: number;
  dayIndex: number;
  dayQuota: number;
  hours: number[];
};

function pad2(v: number): string {
  return v.toString().padStart(2, "0");
}

export function monthKeyUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

export function daysInMonthUTC(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function hoursForCount(count: number): number[] {
  const safe = Math.max(0, Math.min(24, Math.floor(count)));
  if (safe <= 0) {
    return [];
  }
  const slots = new Set<number>();
  for (let i = 0; i < safe; i++) {
    const hour = Math.floor((i * 24) / safe);
    slots.add(hour);
  }
  for (let h = 0; slots.size < safe && h < 24; h++) {
    if (!slots.has(h)) {
      slots.add(h);
    }
  }
  return [...slots].sort((a, b) => a - b);
}

export function buildScheduleForDate(d: Date, totalPerMonth: number): PagesSchedule {
  const total = Math.max(1, Math.floor(totalPerMonth));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const dayCount = daysInMonthUTC(year, month);
  const base = Math.floor(total / dayCount);
  const extra = total % dayCount;
  const dayIndex = d.getUTCDate() - 1;
  const dayQuota = base + (dayIndex < extra ? 1 : 0);
  const hours = hoursForCount(dayQuota);
  return {
    monthKey: monthKeyUTC(d),
    dayCount,
    dayIndex,
    dayQuota,
    hours,
  };
}

export function shouldTriggerSlot(d: Date, totalPerMonth: number): boolean {
  const schedule = buildScheduleForDate(d, totalPerMonth);
  return schedule.hours.includes(d.getUTCHours());
}
