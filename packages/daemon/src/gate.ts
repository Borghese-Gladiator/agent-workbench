export type Claim = { id: string; text: string; proof?: "test" };

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
  writerEnd?: string;
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
    if (mine.length === 0) reasons.push(input.writerEnd ? `no test (test writer: ${input.writerEnd})` : "no test");
    const skipped = tests.some(
      (t) => t.status === "skipped" || t.annotations?.some((a) => a.type === "skip" || a.type === "fixme"),
    );
    if (skipped) reasons.push("skipped");
    if (results.some((r) => r.status !== "passed")) reasons.push("not passed");
    const files = (name: string) =>
      results.map((r) => r.attachments.find((a) => a.name === name && a.path && input.fileExists(a.path))?.path);
    const videos = files("video");
    const traces = files("trace");
    if (c.proof !== "test" && (videos.some((v) => !v) || traces.some((t) => !t))) reasons.push("no video or trace");
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

const unescape = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: "lt" | "gt" | "quot" | "apos" | "amp") => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e]);

export function junitReport(xml: string): Report {
  const specs: ReportSpec[] = [];
  for (const m of xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k: string) => unescape(m[1].match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? "");
    const name = attr("name");
    const fromFile = [attr("file").split("/").pop() ?? "", attr("classname").split("/").pop() ?? ""]
      .map((s) => s.match(/(?:^|\.)(c\d+)[._]/i)?.[1].toUpperCase())
      .find(Boolean);
    const title = /^C\d+\b/.test(name) || !fromFile ? name : `${fromFile}: ${name}`;
    const body = m[2] ?? "";
    if (/<skipped\b/.test(body)) {
      specs.push({ title, tests: [{ status: "skipped", results: [] }] });
      continue;
    }
    const status = /<(failure|error)\b/.test(body) ? "failed" : "passed";
    specs.push({ title, tests: [{ status: "expected", results: [{ status, attachments: [] }] }] });
  }
  return { suites: [{ specs }] };
}

export function claimTable(g: GateResult): string {
  const lines = g.rows.map(
    (r) => `${r.id.padEnd(5)} ${r.status}  tests=${r.tests}${r.reasons.length ? "  " + r.reasons.join(", ") : ""}`,
  );
  return [...lines, `gate: ${g.pass ? "PASS" : "FAIL"} at ${g.head.slice(0, 10)}`].join("\n");
}
