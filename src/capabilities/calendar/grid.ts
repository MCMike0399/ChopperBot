/**
 * Pure calendar-grid math, shared by the PDF renderer and the publisher.
 *
 * The templates lay months out Monday-first (the SEMANA column is the ISO week
 * number, and the first day column is "Lunes"). Everything here works in the
 * deployment's fixed UTC-6 wall clock (see {@link WALL_CLOCK_OFFSET_MS}); a
 * UTC timestamp is mapped to the local calendar day it falls on before being
 * placed in the grid.
 */
import { WALL_CLOCK_OFFSET_MS } from './time.js';

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
}

/** Local (UTC-6) calendar parts of a UTC timestamp. */
export function localParts(utcMs: number): LocalParts {
  const wall = new Date(utcMs + WALL_CLOCK_OFFSET_MS);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
  };
}

/** "2026-06" for year 2026, month 6. */
export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The month key (local) a UTC timestamp falls in. */
export function monthKeyOfUtc(utcMs: number): string {
  const p = localParts(utcMs);
  return monthKey(p.year, p.month);
}

/**
 * The [start, end) UTC window covering the given local month — start of day 1
 * to start of day 1 of the next month, both at local midnight.
 */
export function monthWindowUtc(year: number, month: number): { startMs: number; endMs: number } {
  const startWall = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const endWall = Date.UTC(year, month, 1, 0, 0, 0, 0); // month is 1-based → next month
  return {
    startMs: startWall - WALL_CLOCK_OFFSET_MS,
    endMs: endWall - WALL_CLOCK_OFFSET_MS,
  };
}

/** Days in a (1-based) month. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface GridPosition {
  row: number; // 0-based week row
  col: number; // 0 = Monday … 6 = Sunday
}

/**
 * The Monday-first grid position of a day-of-month. Row 0 holds day 1's week;
 * leading days from the previous month occupy the cells before day 1's column.
 * Matches the templates exactly (e.g. Aug 1 2026 = Saturday → row 0, col 5).
 */
export function dayToCell(year: number, month: number, day: number): GridPosition {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=Sun..6=Sat
  const firstMon = (firstDow + 6) % 7; // 0=Mon..6=Sun
  const idx = firstMon + (day - 1);
  return { row: Math.floor(idx / 7), col: idx % 7 };
}

/** Number of week rows a month spans in the Monday-first layout (5 or 6). */
export function weekRows(year: number, month: number): number {
  const last = daysInMonth(year, month);
  return dayToCell(year, month, last).row + 1;
}
