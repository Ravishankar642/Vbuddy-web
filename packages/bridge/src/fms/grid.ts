import { CDU_COLUMNS, CDU_FLAG_SMALL, CDU_ROWS } from "@vbuddy/protocol";

/** Colour digits (CDU_COLORS). */
export const C = { white: 0, cyan: 1, green: 2, magenta: 3, amber: 4, red: 5, yellow: 6, grey: 7 } as const;

/** One styled character. */
export interface Cell {
  ch: string;
  color: number;
  small: boolean;
}

/** A 24 x 14 screen being filled in, turned into the rows / colours / flags strings of a CduScreen. */
export class Grid {
  private cells: Cell[][] = Array.from({ length: CDU_ROWS }, () => Array.from({ length: CDU_COLUMNS }, () => ({ ch: " ", color: 0, small: false })));

  /** Writes styled characters from column `col` on `row`; anything past the edge is dropped. */
  put(row: number, col: number, text: Cell[]) {
    const r = this.cells[row];
    if (!r) return;
    text.forEach((c, i) => {
      const x = col + i;
      if (x >= 0 && x < CDU_COLUMNS) r[x] = c;
    });
  }

  /** Left-aligned, right-aligned or centred on a row. */
  place(row: number, text: Cell[], align: "left" | "right" | "center") {
    if (!text.length) return;
    const col = align === "left" ? 0 : align === "right" ? CDU_COLUMNS - text.length : Math.floor((CDU_COLUMNS - text.length) / 2);
    this.put(row, Math.max(0, col), align === "right" && text.length > CDU_COLUMNS ? text.slice(text.length - CDU_COLUMNS) : text);
  }

  /** Is this cell still blank (for laying arrows into a free corner)? */
  free(row: number, col: number) {
    return this.cells[row]?.[col]?.ch === " ";
  }

  out(): { rows: string[]; colors: string[]; flags: string[] } {
    return {
      rows: this.cells.map((r) => r.map((c) => c.ch).join("")),
      colors: this.cells.map((r) => r.map((c) => String(c.color)).join("")),
      flags: this.cells.map((r) => r.map((c) => (c.small ? String(CDU_FLAG_SMALL) : "0")).join("")),
    };
  }
}

/** Plain text in one style. */
export const plain = (s: string, color = 0, small = false): Cell[] => [...s].map((ch) => ({ ch, color, small }));
