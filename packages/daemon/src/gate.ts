export type Claim = { id: string; text: string; proof?: "test" };

export type ReportResult = { status: string; attachments: { name: string; path?: string }[]; error?: string };
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
  startError?: string;
  baseReport?: Report;
  carried?: Carried[];
  kept?: Record<string, string>;
};

export type Carried = { label: string; claims: Claim[]; report: Report };

export type GateRow = {
  id: string;
  tests: number;
  status: "PASS" | "FAIL";
  reasons: string[];
  videos: string[];
  traces: string[];
  kept?: string;
  error?: string;
  sameOnBase?: boolean;
};
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

  const row = (c: Claim, specs: ReportSpec[], id = c.id, baseSpecs: ReportSpec[] = [], kept?: string): GateRow => {
    if (kept) {
      const reasons = [...global];
      return { id, tests: 0, status: reasons.length ? "FAIL" : "PASS", reasons, videos: [], traces: [], kept };
    }
    const mine = specs.filter((s) => new RegExp(`^${c.id}\\b`).test(s.title));
    const tests = mine.flatMap((s) => s.tests);
    const results = tests.flatMap((t) => t.results);
    const reasons: string[] = [];
    if (mine.length === 0 && c.proof !== "test" && input.startError) reasons.push(`Playwright did not start: ${input.startError}`);
    else if (mine.length === 0) reasons.push(input.writerEnd ? `no test (test writer: ${input.writerEnd})` : "no test");
    const skipped = tests.some(
      (t) => t.status === "skipped" || t.annotations?.some((a) => a.type === "skip" || a.type === "fixme"),
    );
    if (skipped) reasons.push("skipped");
    if (results.some((r) => r.status !== "passed")) reasons.push("not passed");
    const onBase = baseSpecs.filter((s) => new RegExp(`^${c.id}\\b`).test(s.title)).flatMap((s) => s.tests);
    if (c.proof === "test" && onBase.length && onBase.every((t) => t.results.length && t.results.every((r) => r.status === "passed")))
      reasons.push("passes on the base commit");
    const files = (name: string) =>
      results.map((r) => r.attachments.find((a) => a.name === name && a.path && input.fileExists(a.path))?.path);
    const videos = files("video");
    const traces = files("trace");
    if (c.proof !== "test" && traces.some((t) => !t)) reasons.push("no video or trace");
    reasons.push(...global);
    const error = results.find((r) => r.status !== "passed" && r.error)?.error;
    const baseErrors = onBase.flatMap((t) => t.results.map((r) => r.error));
    return {
      id,
      tests: tests.length,
      status: reasons.length ? "FAIL" : "PASS",
      reasons,
      videos: videos.filter((v): v is string => !!v),
      traces: traces.filter((t): t is string => !!t),
      ...(error ? { error, ...(baseErrors.includes(error) ? { sameOnBase: true } : {}) } : {}),
    };
  };
  const specs = specsOf(input.report);
  const baseSpecs = input.baseReport ? specsOf(input.baseReport) : [];
  const rows = [
    ...input.claims.map((c) => row(c, specs, c.id, baseSpecs, input.kept?.[c.id])),
    ...(input.carried ?? []).flatMap((k) => k.claims.map((c) => row(c, specsOf(k.report), `${k.label}/${c.id}`))),
  ];
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
    const fail = body.match(/<(?:failure|error)\b((?:[^>"]|"[^"]*")*)>/);
    const status = fail ? "failed" : "passed";
    const error = fail ? unescape((fail[1].match(/\bmessage="([^"]*)"/)?.[1] ?? "").replace(/&#10;/g, "\n")).split("\n")[0].slice(0, 300) : "";
    specs.push({ title, tests: [{ status: "expected", results: [{ status, attachments: [], ...(error ? { error } : {}) }] }] });
  }
  return { suites: [{ specs }] };
}

export function claimTable(g: GateResult): string {
  const lines = g.rows.map(
    (r) =>
      `${r.id.padEnd(5)} ${r.status}  tests=${r.tests}${r.kept ? `  kept from ${r.kept.slice(0, 10)}` : ""}${r.reasons.length ? "  " + r.reasons.join(", ") : ""}${r.error ? `  error: ${r.error}` : ""}`,
  );
  return [...lines, `gate: ${g.pass ? "PASS" : "FAIL"} at ${g.head.slice(0, 10)}`].join("\n");
}
