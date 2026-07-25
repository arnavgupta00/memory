export type ResolvedDateOperand = {
  surface: string;
  isoDate: string;
};

export type ClockTimeOperand = {
  surface: string;
  normalized: string;
};

export type MeasuredOperand = {
  surface: string;
  value: number;
  unit: string;
};

export type NumericRangeOperand = {
  surface: string;
  minimum: number;
  maximum: number;
  unit: string | null;
};

export type SignalOperandHints = {
  resolvedDates: ResolvedDateOperand[];
  clockTimes: ClockTimeOperand[];
  durations: MeasuredOperand[];
  frequencies: MeasuredOperand[];
  numericRanges: NumericRangeOperand[];
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function parseSessionDate(sessionDate: string): Date | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})/u.exec(sessionDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function numberValue(surface: string): number | null {
  const numeric = Number(surface);
  if (Number.isFinite(numeric)) return numeric;
  return NUMBER_WORDS[surface.toLocaleLowerCase()] ?? null;
}

function resolveDates(text: string, sessionDate: string): ResolvedDateOperand[] {
  const anchor = parseSessionDate(sessionDate);
  if (!anchor) return [];
  const results: ResolvedDateOperand[] = [];
  for (const match of text.matchAll(/\b(today|yesterday|tomorrow)\b/giu)) {
    const surface = match[0];
    const offset = surface.toLocaleLowerCase() === "yesterday"
      ? -1
      : surface.toLocaleLowerCase() === "tomorrow" ? 1 : 0;
    results.push({ surface, isoDate: isoDate(addUtcDays(anchor, offset)) });
  }
  for (const match of text.matchAll(/\b(last|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/giu)) {
    const direction = match[1]?.toLocaleLowerCase();
    const weekday = WEEKDAYS[match[2]?.toLocaleLowerCase() ?? ""];
    if (weekday === undefined) continue;
    const current = anchor.getUTCDay();
    const distance = direction === "last"
      ? -(((current - weekday + 6) % 7) + 1)
      : ((weekday - current + 6) % 7) + 1;
    results.push({ surface: match[0], isoDate: isoDate(addUtcDays(anchor, distance)) });
  }
  return results;
}

function clockTimes(text: string): ClockTimeOperand[] {
  return [...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/giu)].flatMap((match) => {
    const hour = Number(match[1]);
    const minute = Number(match[2] ?? "0");
    const meridiem = match[3]?.toLocaleLowerCase();
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59 || !meridiem) return [];
    const normalizedHour = hour % 12 + (meridiem === "pm" ? 12 : 0);
    return [{
      surface: match[0],
      normalized: `${String(normalizedHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    }];
  });
}

function measuredOperands(
  text: string,
  pattern: RegExp,
  normalizeUnit: (unit: string) => string,
): MeasuredOperand[] {
  return [...text.matchAll(pattern)].flatMap((match) => {
    const value = numberValue(match[1] ?? "");
    const unit = match[2];
    if (value === null || !unit) return [];
    return [{ surface: match[0], value, unit: normalizeUnit(unit.toLocaleLowerCase()) }];
  });
}

function durations(text: string): MeasuredOperand[] {
  return measuredOperands(
    text,
    /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/giu,
    (unit) => unit.replace(/s$/u, ""),
  );
}

function frequencies(text: string): MeasuredOperand[] {
  return measuredOperands(
    text,
    /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+times?\s+(?:a|per)\s+(day|week|month|year)\b/giu,
    (unit) => `times_per_${unit}`,
  );
}

function numericRanges(text: string): NumericRangeOperand[] {
  return [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(%|seconds?|minutes?|hours?|days?|weeks?|months?|years?)?/giu)]
    .flatMap((match) => {
      const minimum = Number(match[1]);
      const maximum = Number(match[2]);
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [];
      const unit = match[3]?.toLocaleLowerCase().replace(/s$/u, "") ?? null;
      return [{ surface: match[0], minimum, maximum, unit }];
    });
}

export function signalOperandHints(text: string, sessionDate: string): SignalOperandHints {
  return {
    resolvedDates: resolveDates(text, sessionDate),
    clockTimes: clockTimes(text),
    durations: durations(text),
    frequencies: frequencies(text),
    numericRanges: numericRanges(text),
  };
}
