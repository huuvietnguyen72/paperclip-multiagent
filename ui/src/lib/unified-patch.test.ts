import { describe, expect, it } from "vitest";
import { foldContext, parseUnifiedPatch } from "./unified-patch";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -40,4 +40,5 @@ export function App() {",
  "   const { data } = useBookings();",
  "-  return <List items={data} />;",
  "+  const [view, setView] = useState('list');",
  "+  return <Calendar view={view} />;",
  "   // end",
  "@@ -90 +91 @@",
  "-old tail",
  "+new tail",
  "\\ No newline at end of file",
].join("\n");

describe("parseUnifiedPatch", () => {
  it("numbers context, deleted and added lines from each hunk header", () => {
    const hunks = parseUnifiedPatch(PATCH);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.header).toBe("@@ -40,4 +40,5 @@ export function App() {");
    expect(hunks[0]!.lines).toEqual([
      { kind: "context", oldNo: 40, newNo: 40, text: "  const { data } = useBookings();" },
      { kind: "del", oldNo: 41, newNo: null, text: "  return <List items={data} />;" },
      { kind: "add", oldNo: null, newNo: 41, text: "  const [view, setView] = useState('list');" },
      { kind: "add", oldNo: null, newNo: 42, text: "  return <Calendar view={view} />;" },
      { kind: "context", oldNo: 42, newNo: 43, text: "  // end" },
    ]);
  });

  it("handles single-line hunk headers and ignores the no-newline marker", () => {
    const [, second] = parseUnifiedPatch(PATCH);
    expect(second!.lines).toEqual([
      { kind: "del", oldNo: 90, newNo: null, text: "old tail" },
      { kind: "add", oldNo: null, newNo: 91, text: "new tail" },
    ]);
  });

  it("returns no hunks for an empty or header-only patch", () => {
    expect(parseUnifiedPatch("")).toEqual([]);
    expect(parseUnifiedPatch("diff --git a/x b/x\nnew file mode 100644\n")).toEqual([]);
  });
});

describe("foldContext", () => {
  it("folds runs of more than 6 unchanged lines, keeping 3 on each side", () => {
    const lines = Array.from({ length: 10 }, (_, index) => ({ kind: "context" as const, oldNo: index + 1, newNo: index + 1, text: `l${index}` }));
    const folded = foldContext([...lines, { kind: "add", oldNo: null, newNo: 11, text: "x" }]);
    expect(folded.map((row) => ("folded" in row ? `…${row.folded}` : row.text))).toEqual(["l0", "l1", "l2", "…4", "l7", "l8", "l9", "x"]);
  });

  it("keeps short context runs as they are", () => {
    const lines = Array.from({ length: 6 }, (_, index) => ({ kind: "context" as const, oldNo: index + 1, newNo: index + 1, text: `l${index}` }));
    expect(foldContext(lines)).toHaveLength(6);
  });
});
