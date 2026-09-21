import type { RoadResult } from "./road-live-state";

export type RoadMark = {
  row: number;
  col: number;
  result: RoadResult;
  filled?: boolean;
  tieCount?: number;
  logicalCol?: number;
  logicalRow?: number;
  isNewColumn?: boolean;
};

const cellKey = (col: number, row: number) => `${col}:${row}`;

export function buildRoadWindow(marks: RoadMark[], columns: number): RoadMark[] {
  const lastCol = Math.max(-1, ...marks.map((m) => m.col));
  const start = Math.max(0, lastCol - columns + 1);
  return marks
    .map((m) => ({ ...m, col: m.col - start }))
    .filter((m) => m.col >= 0 && m.col < columns);
}

type LogicalColumn = { result: "莊" | "閒"; length: number };
type BigRoadState = { marks: RoadMark[]; columns: LogicalColumn[] };

/**
 * Standard baccarat Big Road.
 * - ties never consume a cell; they annotate the previous Banker/Player mark
 * - a streak moves downward first
 * - after reaching row 6 or being blocked, that streak forms a horizontal dragon tail
 * - once a streak has turned, it never drops down again
 */
function buildBigRoadState(results: RoadResult[]): BigRoadState {
  const marks: RoadMark[] = [];
  const columns: LogicalColumn[] = [];
  const occupied = new Set<string>();

  let previous: "莊" | "閒" | null = null;
  let logicalCol = -1;
  let baseDisplayCol = -1;
  let last: RoadMark | null = null;
  let turned = false;
  let tailRow = 0;
  let pendingTies = 0;

  for (const raw of results) {
    if (raw === "和") {
      if (last) last.tieCount = (last.tieCount ?? 0) + 1;
      else pendingTies += 1;
      continue;
    }
    const result = raw as "莊" | "閒";
    const newColumn = result !== previous;
    let row = 0;
    let col = 0;
    let logicalRow = 0;

    if (newColumn) {
      logicalCol += 1;
      logicalRow = 0;
      columns[logicalCol] = { result, length: 1 };
      baseDisplayCol += 1;
      while (occupied.has(cellKey(baseDisplayCol, 0))) baseDisplayCol += 1;
      col = baseDisplayCol;
      row = 0;
      turned = false;
      tailRow = 0;
    } else {
      logicalRow = columns[logicalCol]?.length ?? 1;
      columns[logicalCol].length = logicalRow + 1;

      if (!last) {
        col = Math.max(0, baseDisplayCol);
        row = 0;
      } else if (turned) {
        row = tailRow;
        col = last.col + 1;
        while (occupied.has(cellKey(col, row))) col += 1;
      } else {
        const downRow = last.row + 1;
        if (downRow <= 5 && !occupied.has(cellKey(last.col, downRow))) {
          col = last.col;
          row = downRow;
        } else {
          turned = true;
          tailRow = last.row;
          row = tailRow;
          col = last.col + 1;
          while (occupied.has(cellKey(col, row))) col += 1;
        }
      }
    }

    const mark: RoadMark = {
      row,
      col,
      result,
      logicalCol,
      logicalRow,
      isNewColumn: newColumn,
    };
    if (pendingTies) {
      mark.tieCount = pendingTies;
      pendingTies = 0;
    }
    marks.push(mark);
    occupied.add(cellKey(col, row));
    last = mark;
    previous = result;
  }

  return { marks, columns };
}

export function buildBigRoad(results: RoadResult[]): RoadMark[] {
  return buildBigRoadState(results).marks;
}

function placeDerived(sequence: RoadResult[], filled: boolean): RoadMark[] {
  const marks: RoadMark[] = [];
  const occupied = new Set<string>();
  let previous: RoadResult | null = null;
  let baseCol = -1;
  let last: RoadMark | null = null;
  let turned = false;
  let tailRow = 0;

  for (const result of sequence) {
    if (!last || result !== previous) {
      baseCol += 1;
      while (occupied.has(cellKey(baseCol, 0))) baseCol += 1;
      const m: RoadMark = { row: 0, col: baseCol, result, filled };
      marks.push(m); occupied.add(cellKey(m.col, m.row)); last = m; previous = result;
      turned = false; tailRow = 0;
      continue;
    }

    let row: number, col: number;
    if (turned) {
      row = tailRow; col = last.col + 1;
      while (occupied.has(cellKey(col, row))) col += 1;
    } else {
      const down = last.row + 1;
      if (down <= 5 && !occupied.has(cellKey(last.col, down))) {
        row = down; col = last.col;
      } else {
        turned = true; tailRow = last.row; row = tailRow; col = last.col + 1;
        while (occupied.has(cellKey(col, row))) col += 1;
      }
    }
    const m: RoadMark = { row, col, result, filled };
    marks.push(m); occupied.add(cellKey(col, row)); last = m;
  }
  return marks;
}

/**
 * Big Eye Boy / Small Road / Cockroach Road.
 * offset: 1 / 2 / 3. Red/blue are structural colors, encoded as 莊/閒 for renderer reuse.
 */
export function buildDerivedRoad(results: RoadResult[], offset: 1 | 2 | 3, filled: boolean): RoadMark[] {
  const { marks, columns } = buildBigRoadState(results);
  const colors: RoadResult[] = [];

  for (const mark of marks) {
    const c = mark.logicalCol ?? 0;
    const r = mark.logicalRow ?? 0;
    let color: RoadResult | null = null;

    if (r === 0) {
      // New Big-Road column: compare the two earlier column depths separated by offset.
      const a = c - 1;
      const b = c - offset - 1;
      if (b >= 0) color = columns[a]?.length === columns[b]?.length ? "莊" : "閒";
    } else {
      // Continuing streak: compare occupancy at same depth vs the cell above in the look-back column.
      // Use logical depth (infinite downward) so dragon tails do not distort derived roads.
      const ref = c - offset;
      if (ref >= 0) {
        const len = columns[ref]?.length ?? 0;
        const sameRowOccupied = len > r;
        const aboveOccupied = len > r - 1;
        color = sameRowOccupied === aboveOccupied ? "莊" : "閒";
      }
    }
    if (color) colors.push(color);
  }
  return placeDerived(colors, filled);
}

export type AskRoadPrediction = {
  bigEye: RoadResult | null;
  small: RoadResult | null;
  cockroach: RoadResult | null;
};

function nextDerivedColor(results: RoadResult[], outcome: "莊" | "閒", offset: 1 | 2 | 3, filled: boolean): RoadResult | null {
  const before = buildDerivedRoad(results, offset, filled);
  const after = buildDerivedRoad([...results, outcome], offset, filled);
  return after.length > before.length ? after.at(-1)?.result ?? null : null;
}

export function buildAskRoad(results: RoadResult[]): { banker: AskRoadPrediction; player: AskRoadPrediction } {
  const predict = (outcome: "莊" | "閒"): AskRoadPrediction => ({
    bigEye: nextDerivedColor(results, outcome, 1, false),
    small: nextDerivedColor(results, outcome, 2, true),
    cockroach: nextDerivedColor(results, outcome, 3, false),
  });
  return { banker: predict("莊"), player: predict("閒") };
}

export function buildBeadWindow(results: RoadResult[]) {
  return results.slice(-36);
}

/** Bead Plate: top-to-bottom, then left-to-right, latest 36 only. */
export function buildBeadGrid(results: RoadResult[]): Array<RoadResult | undefined> {
  const window = buildBeadWindow(results);
  return Array.from({ length: 36 }, (_, slot) => {
    const row = Math.floor(slot / 6);
    const col = slot % 6;
    return window[col * 6 + row];
  });
}
