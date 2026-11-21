/** Parses `git diff` unified patch text into numbered hunk lines for the Changes panel. */

export interface PatchLine {
  kind: "context" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface PatchHunk {
  header: string;
  lines: PatchLine[];
}

export type FoldedRow = PatchLine | { folded: number };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const FOLD_THRESHOLD = 6;
const FOLD_KEEP = 3;

export function parseUnifiedPatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = { header: line, lines: [] };
      hunks.push(current);
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      continue;
    }
    if (!current || line.startsWith("\\")) continue;
    if (line.startsWith("+")) current.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    else if (line.startsWith(" ")) current.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  return hunks;
}

/** Collapses runs of unchanged lines longer than 6, keeping 3 lines on each side. */
export function foldContext(lines: PatchLine[]): FoldedRow[] {
  const rows: FoldedRow[] = [];
  let run: PatchLine[] = [];
  const flush = () => {
    if (run.length > FOLD_THRESHOLD) {
      rows.push(...run.slice(0, FOLD_KEEP), { folded: run.length - FOLD_KEEP * 2 }, ...run.slice(-FOLD_KEEP));
    } else {
      rows.push(...run);
    }
    run = [];
  };
  for (const line of lines) {
    if (line.kind === "context") {
      run.push(line);
    } else {
      flush();
      rows.push(line);
    }
  }
  flush();
  return rows;
}
