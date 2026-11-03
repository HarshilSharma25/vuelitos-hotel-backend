export const CARACAS_OFFSET_HOURS = -4;
export const CARACAS_OFFSET_MS = CARACAS_OFFSET_HOURS * 60 * 60 * 1000;

export function toCaracasTime(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
  dateString: string;
} {
  const localMs = date.getTime() + CARACAS_OFFSET_MS;
  const d = new Date(localMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const second = d.getUTCSeconds();
  const dayOfWeek = d.getUTCDay();
  const dateString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  return { year, month, day, hour, minute, second, dayOfWeek, dateString };
}

export function fromCaracasParts(year: number, month: number, day: number, hour: number, minute: number, second = 0): Date {
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - CARACAS_OFFSET_MS;
  return new Date(utcMs);
}

export function getCaracasWallDate(date: Date = new Date()): string {
  return toCaracasTime(date).dateString;
}

export function isCaracasBusinessDay(dayOfWeek: number, dateString: string, holidays: Set<string>): boolean {
  if (dayOfWeek === 0) return false;
  if (holidays.has(dateString)) return false;
  return true;
}

export function calculateSlaDueAt(startDate: Date, holidayList: string[] = []): Date {
  const holidays = new Set(holidayList);
  let local = toCaracasTime(startDate);

  let currentYear = local.year;
  let currentMonth = local.month;
  let currentDay = local.day;
  let currentHour = local.hour;
  let currentMinute = local.minute;
  let currentDayOfWeek = local.dayOfWeek;
  let currentDateString = local.dateString;

  const moveToNextDayStart = () => {
    const nextDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay + 1));
    currentYear = nextDate.getUTCFullYear();
    currentMonth = nextDate.getUTCMonth() + 1;
    currentDay = nextDate.getUTCDate();
    currentDayOfWeek = nextDate.getUTCDay();
    currentDateString = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
    currentHour = 8;
    currentMinute = 0;
  };

  while (!isCaracasBusinessDay(currentDayOfWeek, currentDateString, holidays)) {
    moveToNextDayStart();
  }

  if (currentHour < 8) {
    currentHour = 8;
    currentMinute = 0;
  } else if (currentHour >= 18) {
    moveToNextDayStart();
    while (!isCaracasBusinessDay(currentDayOfWeek, currentDateString, holidays)) {
      moveToNextDayStart();
    }
  }

  let remainingMinutes = 240;

  while (remainingMinutes > 0) {
    while (!isCaracasBusinessDay(currentDayOfWeek, currentDateString, holidays)) {
      moveToNextDayStart();
    }

    const currentMinutesFromMidnight = currentHour * 60 + currentMinute;
    const closingMinutesFromMidnight = 18 * 60;
    const availableToday = closingMinutesFromMidnight - currentMinutesFromMidnight;

    if (remainingMinutes <= availableToday) {
      const finalMinutes = currentMinutesFromMidnight + remainingMinutes;
      currentHour = Math.floor(finalMinutes / 60);
      currentMinute = finalMinutes % 60;
      remainingMinutes = 0;
    } else {
      remainingMinutes -= availableToday;
      moveToNextDayStart();
    }
  }

  return fromCaracasParts(currentYear, currentMonth, currentDay, currentHour, currentMinute, 0);
}
