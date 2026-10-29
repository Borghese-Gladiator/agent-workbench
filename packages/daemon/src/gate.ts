export type Claim = { id: string; text: string };

export type ReportResult = { status: string; attachments: { name: string; path?: string }[] };
export type ReportSpec = { title: string; tests: { status?: string; annotations?: { type: string }[]; results: ReportResult[] }[] };
export type ReportSuite = { specs?: ReportSpec[]; suites?: ReportSuite[] };
export type Report = { suites: ReportSuite[] };

export type GateInput = {
  claims: Claim[];
  report: Report;
  head: string;
  savedSha: string;
  dirty: boolean;
  testHashAtStart: string;
  testHashNow: string;
  fileExists: (path: string) => boolean;
};

export type GateRow = { id: string; tests: number; status: "PASS" | "FAIL"; reasons: string[]; videos: string[]; traces: string[] };
export type GateResult = { pass: boolean; rows: GateRow[]; head: string; reasons: string[] };

function specsOf(report: Report): ReportSpec[] {
  const out: ReportSpec[] = [];
  const walk = (s: ReportSuite) => {
    out.push(...(s.specs ?? []));
    (s.suites ?? []).forEach(walk);
  };
  report.suites.forEach(walk);
  return out;
}

export function runGate(input: GateInput): GateResult {
  const global: string[] = [];
  if (input.savedSha !== input.head) global.push("commit changed since the run started");
  if (input.dirty) global.push("source has uncommitted changes");
  if (input.testHashAtStart !== input.testHashNow) global.push("a test file changed after the run started");

  const specs = specsOf(input.report);
  const rows = input.claims.map((c): GateRow => {
    const mine = specs.filter((s) => new RegExp(`^${c.id}\\b`).test(s.title));
    const tests = mine.flatMap((s) => s.tests);
    const results = tests.flatMap((t) => t.results);
    const reasons: string[] = [];
    if (mine.length === 0) reasons.push("no test");
    const skipped = tests.some(
      (t) => t.status === "skipped" || t.annotations?.some((a) => a.type === "skip" || a.type === "fixme"),
    );
    if (skipped) reasons.push("skipped");
    if (results.some((r) => r.status !== "passed")) reasons.push("not passed");
    const files = (name: string) =>
      results.map((r) => r.attachments.find((a) => a.name === name && a.path && input.fileExists(a.path))?.path);
    const videos = files("video");
    const traces = files("trace");
    if (videos.some((v) => !v) || traces.some((t) => !t)) reasons.push("no video or trace");
    reasons.push(...global);
    return {
      id: c.id,
      tests: tests.length,
      status: reasons.length ? "FAIL" : "PASS",
      reasons,
      videos: videos.filter((v): v is string => !!v),
      traces: traces.filter((t): t is string => !!t),
    };
  });
  return { pass: rows.length > 0 && rows.every((r) => r.status === "PASS"), rows, head: input.head, reasons: global };
}

export function claimTable(g: GateResult): string {
  const lines = g.rows.map(
    (r) => `${r.id.padEnd(5)} ${r.status}  tests=${r.tests}${r.reasons.length ? "  " + r.reasons.join(", ") : ""}`,
  );
  return [...lines, `gate: ${g.pass ? "PASS" : "FAIL"} at ${g.head.slice(0, 10)}`].join("\n");
}
