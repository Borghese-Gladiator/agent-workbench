import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readPackageJson,
  readTextFile,
  pathExists,
  readProcfileCommand,
  readComposeServices,
  readMakeLikeTargets,
  readPipfileScripts,
  readPyprojectScripts,
} from './manifests.js';

export type RunCommandSource =
  | 'procfile'
  | 'docker-compose'
  | 'make-target'
  | 'package-script'
  | 'pipfile-script'
  | 'pyproject-script'
  | 'framework-inference'
  | 'language-default';

/**
 * A resolved way to run a produced project. `serves: true` is a long-running web/dev server the
 * browser-QA path can drive (it carries the `baseUrl` a browser loads); `serves: false` is a one-shot
 * run / CLI / compiled binary that exits — captured so a future non-browser QA consumer can use it,
 * but never handed to `waitForServer` (which would hang waiting on a port nothing binds).
 */
export type ResolvedRunCommand =
  | { command: string; source: RunCommandSource; serves: true; baseUrl: string }
  | { command: string; source: RunCommandSource; serves: false };

const DEFAULT_PORT = 5173;

function portFromUrl(url: string | undefined, fallback: number): number {
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === 'https:' ? 443 : fallback;
  } catch {
    return fallback;
  }
}

function serverResult(command: string, source: RunCommandSource, port: number): ResolvedRunCommand {
  return { command, source, serves: true, baseUrl: `http://127.0.0.1:${port}` };
}

/** Heuristic: does a shell command look like it starts a long-running server (binds a port)? */
function looksLikeServer(command: string): boolean {
  return /(--port|-p\s|\brunserver\b|\buvicorn\b|\bgunicorn\b|\bflask run\b|\bnext\b|\bvite\b|\bserve\b|\bhttp-server\b|bootRun|spring-boot:run|ListenAndServe|:\d{2,5}\b)/i.test(
    command,
  );
}

function portFromCommand(command: string): number | undefined {
  const flag = command.match(/(?:--port[=\s]+|-p\s+)(\d{2,5})/);
  if (flag) return Number.parseInt(flag[1] as string, 10);
  const colon = command.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:(\d{2,5})\b/);
  if (colon) return Number.parseInt(colon[1] as string, 10);
  return undefined;
}

interface Ctx {
  dir: string;
  requestedBaseUrl?: string;
}

type Matcher = (ctx: Ctx) => Promise<ResolvedRunCommand | undefined>;

// ─── Layer 1: explicit run declarations (language-agnostic, highest confidence) ───

const matchProcfile: Matcher = async ({ dir, requestedBaseUrl }) => {
  const command = await readProcfileCommand(dir);
  if (!command) return undefined;
  if (looksLikeServer(command)) {
    const port = portFromCommand(command) ?? portFromUrl(requestedBaseUrl, DEFAULT_PORT);
    return serverResult(command, 'procfile', port);
  }
  return { command, source: 'procfile', serves: false };
};

const matchCompose: Matcher = async ({ dir, requestedBaseUrl }) => {
  const services = await readComposeServices(dir);
  const web = services.find((s) => s.ports.length > 0) ?? services.find((s) => s.command);
  if (!web) return undefined;
  const command = web.command ?? `docker compose up ${web.name}`;
  const port = web.ports[0] ?? portFromCommand(command) ?? portFromUrl(requestedBaseUrl, DEFAULT_PORT);
  if (web.ports.length > 0 || looksLikeServer(command)) return serverResult(command, 'docker-compose', port);
  return { command, source: 'docker-compose', serves: false };
};

const RUN_TARGET_NAMES = ['dev', 'serve', 'start', 'run', 'server'];

const matchMakeLike: Matcher = async ({ dir, requestedBaseUrl }) => {
  const found = await readMakeLikeTargets(dir);
  if (!found) return undefined;
  const target = RUN_TARGET_NAMES.find((name) => found.targets.includes(name));
  if (!target) return undefined;
  const prefix = found.runner === 'make' ? 'make' : found.runner === 'just' ? 'just' : 'task';
  const command = `${prefix} ${target}`;
  // A make/just/task `run`/`dev`/`serve` target is very likely a server for a web app; default to
  // serving with the requested/default port (the target itself owns the real binding).
  const port = portFromUrl(requestedBaseUrl, DEFAULT_PORT);
  return target === 'run' ? { command, source: 'make-target', serves: false } : serverResult(command, 'make-target', port);
};

// ─── Layer 2: ecosystem framework / convention inference ───

function nodeRunner(packageManager: string | undefined): string {
  const pm = packageManager?.split('@')[0] ?? 'npm';
  return pm === 'yarn' ? 'yarn' : pm === 'pnpm' ? 'pnpm' : 'npm run';
}

const matchNode: Matcher = async ({ dir, requestedBaseUrl }) => {
  const pkg = await readPackageJson(dir);
  if (!pkg) return undefined;
  const runner = nodeRunner(pkg.packageManager);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const port = portFromUrl(requestedBaseUrl, DEFAULT_PORT);

  // Prefer the script the builder actually wrote, over an assumed framework command.
  const scriptName = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
  if (scriptName) {
    const body = scripts[scriptName] as string;
    const command = `${runner} ${scriptName}`;
    if (looksLikeServer(body) || deps.next || deps.vite || deps['react-scripts'] || (await pathExists(join(dir, 'index.html')))) {
      return serverResult(command, 'package-script', portFromCommand(body) ?? port);
    }
    return { command, source: 'package-script', serves: false };
  }

  if (deps.next) return serverResult(`${runner} next dev -p ${port}`.replace('npm run ', 'npx '), 'framework-inference', port);
  if (deps.vite || (await pathExists(join(dir, 'index.html'))))
    return serverResult(`npx vite --host 127.0.0.1 --port ${port}`, 'framework-inference', port);
  if (deps['react-scripts']) return serverResult('npx react-scripts start', 'framework-inference', 3000);
  return undefined;
};

const PY_ENTRY_CANDIDATES = ['app/main.py', 'main.py', 'src/main.py', 'app/app.py', 'app.py'];

async function pyModulePathFor(dir: string, predicate: (raw: string) => boolean): Promise<string | undefined> {
  for (const file of PY_ENTRY_CANDIDATES) {
    const raw = await readTextFile(dir, file);
    if (raw && predicate(raw)) return file.replace(/\.py$/, '').replace(/\//g, '.');
  }
  return undefined;
}

const matchPython: Matcher = async ({ dir, requestedBaseUrl }) => {
  const port = portFromUrl(requestedBaseUrl, 8000);

  if (await pathExists(join(dir, 'manage.py'))) {
    return serverResult(`python manage.py runserver 127.0.0.1:${port}`, 'framework-inference', port);
  }

  const fastApiModule = await pyModulePathFor(dir, (raw) => /\bFastAPI\s*\(/.test(raw) && /\bapp\s*=/.test(raw));
  if (fastApiModule) {
    return serverResult(`python -m uvicorn ${fastApiModule}:app --host 127.0.0.1 --port ${port}`, 'framework-inference', port);
  }

  const flaskModule = await pyModulePathFor(dir, (raw) => /\bFlask\s*\(/.test(raw) && /\bapp\s*=/.test(raw));
  if (flaskModule) {
    return serverResult(`python -m flask --app ${flaskModule} run --host 127.0.0.1 --port ${port}`, 'framework-inference', port);
  }

  return undefined;
};

const matchPythonScripts: Matcher = async ({ dir, requestedBaseUrl }) => {
  const pipfile = await readPipfileScripts(dir);
  const pyproject = await readPyprojectScripts(dir);
  const scripts = { ...pyproject, ...pipfile };
  const name = ['dev', 'serve', 'start', 'run'].find((s) => scripts[s]);
  if (!name) return undefined;
  const body = scripts[name] as string;
  const runner = Object.keys(pipfile).length > 0 ? `pipenv run ${name}` : body;
  if (looksLikeServer(body)) {
    const port = portFromCommand(body) ?? portFromUrl(requestedBaseUrl, 8000);
    return serverResult(runner, 'pipfile-script', port);
  }
  return { command: runner, source: Object.keys(pipfile).length > 0 ? 'pipfile-script' : 'pyproject-script', serves: false };
};

const matchGo: Matcher = async ({ dir, requestedBaseUrl }) => {
  if (!(await pathExists(join(dir, 'go.mod')))) return undefined;
  const servesHttp = await goHasHttpServer(dir);
  if (servesHttp) {
    const port = portFromUrl(requestedBaseUrl, 8080);
    return serverResult('go run .', 'framework-inference', port);
  }
  return { command: 'go run .', source: 'language-default', serves: false };
};

async function goHasHttpServer(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.go')) continue;
      const raw = await readFile(join(dir, entry.name), 'utf8');
      if (/ListenAndServe|http\.Handle|gin\.|echo\.New|fiber\.New/.test(raw)) return true;
    }
  } catch {
    // unreadable dir — treat as no server
  }
  return false;
}

const matchJvm: Matcher = async ({ dir, requestedBaseUrl }) => {
  const port = portFromUrl(requestedBaseUrl, 8080);
  const gradle = (await pathExists(join(dir, 'build.gradle'))) || (await pathExists(join(dir, 'build.gradle.kts')));
  const maven = await pathExists(join(dir, 'pom.xml'));
  const ant = await pathExists(join(dir, 'build.xml'));
  const isSpring = await jvmHasSpringBoot(dir);

  if (gradle) {
    const wrapper = (await pathExists(join(dir, 'gradlew'))) ? './gradlew' : 'gradle';
    return isSpring ? serverResult(`${wrapper} bootRun`, 'framework-inference', port) : { command: `${wrapper} run`, source: 'language-default', serves: false };
  }
  if (maven) {
    const wrapper = (await pathExists(join(dir, 'mvnw'))) ? './mvnw' : 'mvn';
    return isSpring
      ? serverResult(`${wrapper} spring-boot:run`, 'framework-inference', port)
      : { command: `${wrapper} exec:java`, source: 'language-default', serves: false };
  }
  if (ant) return { command: 'ant run', source: 'language-default', serves: false };
  return undefined;
};

async function jvmHasSpringBoot(dir: string): Promise<boolean> {
  for (const file of ['build.gradle', 'build.gradle.kts', 'pom.xml']) {
    const raw = await readTextFile(dir, file);
    if (raw && /spring-boot|springframework\.boot/.test(raw)) return true;
  }
  return false;
}

const matchC: Matcher = async ({ dir }) => {
  const hasMake = await pathExists(join(dir, 'Makefile'));
  const hasCmake = await pathExists(join(dir, 'CMakeLists.txt'));
  const hasSource = await dirHasExt(dir, ['.c', '.cc', '.cpp', '.cxx']);
  if (!hasSource) return undefined;
  if (hasCmake) return { command: 'cmake -B build && cmake --build build', source: 'language-default', serves: false };
  if (hasMake) return { command: 'make', source: 'language-default', serves: false };
  return { command: 'cc *.c -o app && ./app', source: 'language-default', serves: false };
};

async function dirHasExt(dir: string, exts: string[]): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some((e) => e.isFile() && exts.some((ext) => e.name.endsWith(ext)));
  } catch {
    return false;
  }
}

// Order = explicit-first globally, then per-language/framework inference. First match wins.
const MATCHERS: Matcher[] = [
  matchProcfile,
  matchCompose,
  matchMakeLike,
  matchNode,
  matchPythonScripts,
  matchPython,
  matchJvm,
  matchGo,
  matchC,
];

/**
 * Comprehensively resolves how to run a produced project, across ecosystems, using an explicit-first
 * strategy: language-agnostic run declarations (Procfile, docker-compose, Make/just/Task targets,
 * package/Pipfile/pyproject scripts) win over framework inference (Django/FastAPI/Flask, Next/Vite/CRA,
 * Spring Boot, Go net/http), which wins over a bare language default (`go run .`, `make`). Each result
 * is tagged `serves` — a web/dev server (with a `baseUrl` for browser QA) vs a one-shot run / CLI /
 * compiled binary. Returns undefined only when no ecosystem is recognized at all; the caller then
 * keeps its own fallback. Pure over the filesystem — no DB, no process spawn.
 */
export async function resolveRunCommand(
  worktreePath: string,
  opts: { requestedBaseUrl?: string } = {},
): Promise<ResolvedRunCommand | undefined> {
  const ctx: Ctx = { dir: worktreePath, requestedBaseUrl: opts.requestedBaseUrl };
  for (const matcher of MATCHERS) {
    const result = await matcher(ctx);
    if (result) return result;
  }
  return undefined;
}
