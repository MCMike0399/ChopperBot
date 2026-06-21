/**
 * Grid geometry of the monthly calendar PDF templates.
 *
 * The concrete numbers live in `template-geometry.generated.ts`, produced by
 * `scripts/calibrate-calendar-templates.ts` from the real PDFs in `calendar/`.
 * This module owns the shape of that data and the math that turns a (row, col)
 * grid position into a drawable rectangle in pdf-lib coordinates.
 *
 * Two coordinate systems are in play:
 *  - **bbox space** (how the geometry is stored): top-left origin, y grows
 *    DOWN, PDF points — matches poppler's `pdftotext -bbox`.
 *  - **pdf-lib space** (what the renderer draws in): bottom-left origin, y
 *    grows UP. Conversion is `pdfY = pageHeight - bboxY`.
 */

/** A day column (Mon→Sun), x-extent in bbox space. */
export interface GeomColumn {
  left: number;
  right: number;
}

/** A week row, vertical anchors of its day-number glyphs in bbox space. */
export interface GeomRow {
  /** Top (yMin) of the day-number text. */
  numberTop: number;
  /** Bottom (yMax) of the day-number text — events are drawn below this. */
  numberBottom: number;
}

export interface MonthTemplateGeometry {
  /** "2026-06". */
  monthKey: string;
  /** Template filename under `calendar/`, e.g. "Junio 2026.pdf". */
  file: string;
  pageWidth: number;
  pageHeight: number;
  /** Median vertical distance between consecutive rows' day numbers. */
  rowPitch: number;
  /** Exactly 7 columns, Monday→Sunday. */
  columns: GeomColumn[];
  /** Week rows, top→bottom. 5 or 6 depending on the month. */
  rows: GeomRow[];
}

/** Drawable area inside one day cell, in pdf-lib coordinates (y grows up). */
export interface CellBox {
  /** Left edge. */
  x: number;
  /** Top edge (higher y); text is laid out downward from here. */
  top: number;
  /** Bottom edge (lower y). */
  bottom: number;
  /** Usable width. */
  width: number;
  /** top − bottom. */
  height: number;
}

// Padding (PDF points) carved out of each cell so event chips sit clearly
// inside the printed grid lines (columns are the TRUE cell borders detected
// from the vector grid, so this is symmetric breathing room) and below the day
// number above them.
const COL_PAD_LEFT = 9;
const COL_PAD_RIGHT = 9;
const NUMBER_GAP = 6; // gap below the day number before events start
const ROW_BOTTOM_PAD = 7; // gap above the NEXT cell's day number

/**
 * The drawable box for the cell at grid (row, col), in pdf-lib coordinates.
 * `row`/`col` are zero-based; col 0 = Monday. Returns null if out of range for
 * this template (e.g. a 6th row in a 5-row month).
 */
export function cellBox(
  geom: MonthTemplateGeometry,
  row: number,
  col: number,
): CellBox | null {
  if (row < 0 || row >= geom.rows.length) return null;
  if (col < 0 || col >= geom.columns.length) return null;

  const column = geom.columns[col];
  const r = geom.rows[row];
  const next = geom.rows[row + 1];

  const leftBbox = column.left + COL_PAD_LEFT;
  const rightBbox = column.right - COL_PAD_RIGHT;
  const topBbox = r.numberBottom + NUMBER_GAP;
  // Bottom of the band = just above the next row's day number (or one pitch
  // down for the last row).
  const nextTopBbox = next ? next.numberTop : r.numberTop + geom.rowPitch;
  const bottomBbox = nextTopBbox - ROW_BOTTOM_PAD;

  const width = rightBbox - leftBbox;
  const top = geom.pageHeight - topBbox; // flip to pdf-lib
  const bottom = geom.pageHeight - bottomBbox;
  return {
    x: leftBbox,
    top,
    bottom,
    width,
    height: top - bottom,
  };
}
