#!/usr/bin/env bun
// rig: tiny shared state + launcher for a herdr manager/worker/reviewer setup. All judgement lives in skills/.
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

// argv rig starts itself uses rig's own bun (process.execPath), not "bun" from PATH: herdr-app runs argv without a shell,
// and an app started from the dock may lack it. Text typed into a person's shell (`rig …`) still uses their PATH.
const SKILLS = join(import.meta.dir, "skills").replace(/\\/g, "/");
const sh = (cmd: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};
const die = (msg: string): never => { console.error(`rig: ${msg}`); process.exit(1); };
const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// ---- harnesses: data, not code. "{model}" expands to the `model` args, then the `effort` args (each dropped when unset). Prompt is appended last.
// launch: the interactive command takes the first prompt as its last argument. Typing it into a booting TUI can be lost,
// or worse, answer a startup dialog (the claude folder-trust prompt defaults to "No, exit"). Without launch, rig types it.
/** where the next overflow run goes, given the live panes of one overflow tab in open order: a split off `anchor`, or a new tab.
 *  Left column first: each split halves a pane, so splitting c0, c0, c1 gives four equal rows (no ratio needed on either backend).
 *  Then the right column: one pane beside each left row, so it is two true columns. After a close the count is lower, so the gap just fills. */
export function slot(panes: string[], max = 8): { place: "tab" | "right" | "down", anchor?: string } {
  const n = panes.length, half = Math.ceil(max / 2);
  if (n === 0 || n >= max) return { place: "tab" };
  if (n >= half) return { place: "right", anchor: panes[n - half] };
  return { place: "down", anchor: panes[n - 2 ** Math.floor(Math.log2(n))] };
}

/** what a dispatch does about the worktree. setting: on | off | herdr (herdr = a space of its own, worker left, reviewer right).
 *  space: the run goes into the ticket's own space; git: rig makes the worktree itself with `git worktree add`
 *  (a space in the app also has git make it; on the herdr CLI `herdr worktree create` does). Headless runs have no pane, so they never use a space. */
export function worktreePlan(role: string, setting: string, noWorktree: boolean, mode: string, hasWorktree: boolean, hasSpace: boolean) {
  const space = mode !== "headless" && (hasSpace || (!noWorktree && setting === "herdr" && (role === "worker" || hasWorktree)));
  const git = role === "worker" && !hasWorktree && !noWorktree && (setting === "on" || (setting === "herdr" && !space));
  return { space, git };
}
/** first value of `key` anywhere in a parsed herdr JSON reply (its shapes nest differently per command) */
export function deep(o: any, key: string): any {
  if (o && typeof o === "object") {
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const r = deep(v, key); if (r !== undefined) return r; }
  }
}
const jsonOf = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

export const HARNESSES: Record<string, any> = {
  claude: { kind: "claude", launch: true, model: ["--model", "{model}"], effort: ["--effort", "{effort}"],
    interactive: ["claude", "--dangerously-skip-permissions", "--session-id", "{sid}", "{model}"],
    headless: ["claude", "-p", "--dangerously-skip-permissions", "--session-id", "{sid}", "{model}"],
    resume: ["claude", "-p", "--dangerously-skip-permissions", "--resume", "{sid}", "{model}"] },
  codex: { kind: "codex", launch: true, model: ["-m", "{model}"], effort: ["-c", "model_reasoning_effort={effort}"],
    interactive: ["codex", "--dangerously-bypass-approvals-and-sandbox", "{model}"],
    headless: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "{model}"],
    // ponytail: --last picks the newest session in this cwd; fine with one worktree per ticket, wrong without worktrees
    resume: ["codex", "exec", "resume", "--last", "--dangerously-bypass-approvals-and-sandbox", "{model}"] },
  omp: { kind: "omp", launch: true, model: ["--model={model}"], effort: ["--thinking={effort}"],
    interactive: ["omp", "{model}"],
    headless: ["omp", "-p", "{model}"],
    resume: ["omp", "-p", "--continue", "{model}"] },
  pi: { kind: "pi", launch: true, model: ["--model", "{model}"], effort: ["--thinking", "{effort}"],
    interactive: ["pi", "--session-id", "{sid}", "{model}", "--"],
    headless: ["pi", "-p", "--session-id", "{sid}", "{model}"],
    resume: ["pi", "-p", "--session-id", "{sid}", "{model}"] },
  // opencode v2: effort is the model's #variant; session ids must start with ses_ (-s creates it).
  // ponytail: the v2 TUI has no --model, so pane/tab runs use opencode's configured model; headless honours it
  opencode: { kind: "opencode", launch: true, model: ["-m", "{model}#{effort}"],
    interactive: ["opencode", "--auto", "-s", "ses_{sid}", "--prompt"],
    headless: ["opencode", "run", "--auto", "-s", "ses_{sid}", "{model}"],
    resume: ["opencode", "run", "--auto", "-s", "ses_{sid}", "{model}"] },
  commandcode: { model: ["-m", "{model}"], effort: ["--effort", "{effort}"],
    interactive: ["commandcode", "-t", "--permission-mode", "yolo", "{model}"],
    headless: ["commandcode", "-t", "--permission-mode", "yolo", "--tools-all", "{model}", "-p"],
    resume: ["commandcode", "-t", "--permission-mode", "yolo", "--tools-all", "-c", "{model}", "-p"] },
};
export function argv(h: any, kind: "interactive" | "headless" | "resume", model: string, sid: string, prompt?: string, effort = "") {
  const out: string[] = [];
  for (const a of h[kind]) {
    if (a === "{model}") {
      if (model) out.push(...h.model.map((x: string) => x.replace("{model}", model).replace("#{effort}", effort ? `#${effort}` : "")));
      if (effort && h.effort && (!h.effortOnly || h.effortOnly.includes(kind))) out.push(...h.effort.map((x: string) => x.replace("{effort}", effort)));
    }
    else out.push(a.replace("{sid}", sid));
  }
  if (prompt !== undefined) out.push(prompt);
  return out;
}

/** a repo's manager, started by the orchestrator: the manager skill, its brief, and who it reports to */
export function launchCmd(h: any, brief: string, model: string, effort: string, sid: string) {
  const prompt = `You are the rig manager for this repo, started by an orchestrator. Run \`rig skill manager\` and follow it. `
    + `Your brief: ${brief}. Send questions and status to the orchestrator with \`rig say orchestrator "…"\`.`;
  return { prompt, cmd: argv(h, "interactive", model, sid, h.launch ? prompt : undefined, effort) };
}

/** Windows: resolve npm `.cmd` shims to the real exe/script so args survive and kills reach the real process. */
function bin(argv0: string): string[] {
  const found = Bun.which(argv0);
  if (process.platform !== "win32" || !found?.toLowerCase().endsWith(".cmd")) return [found ?? argv0];
  const target = [...readFileSync(found, "utf8").matchAll(/"?%~?dp0%?\\?([^"\s%]+\.(?:exe|m?js))"?/gi)].at(-1)?.[1];
  if (!target) return [found];
  const full = join(dirname(found), target);
  return full.toLowerCase().endsWith(".exe") ? [full] : ["node", full];
}

// ---- db: <repo>/.rig/rig.db, shared by every manager and worktree of the repo
function repoRoot() {
  if (process.env.RIG_ROOT) return process.env.RIG_ROOT;
  const r = sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!r.ok) die("not inside a git repo");
  return dirname(r.out);
}
export function open(path: string) {
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT DEFAULT 'open',
      manager TEXT, review INTEGER DEFAULT 0, branch TEXT, worktree TEXT, created TEXT);
    CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, ticket TEXT, role TEXT, harness TEXT, model TEXT, mode TEXT,
      pane TEXT, sid TEXT, pid INTEGER, cmd TEXT, status TEXT, cwd TEXT, started TEXT);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, ticket TEXT, frm TEXT, too TEXT, body TEXT,
      seen INTEGER DEFAULT 0, at TEXT);
    CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);`);
  // columns added later; older DBs get them on open
  try { db.exec("ALTER TABLE runs ADD COLUMN effort TEXT"); } catch {}
  try { db.exec("ALTER TABLE tickets ADD COLUMN after TEXT"); } catch {} // "T-3,T-4": waits for these
  try { db.exec("ALTER TABLE tickets ADD COLUMN base TEXT"); } catch {} // branch it starts from and lands on
  try { db.exec("ALTER TABLE tickets ADD COLUMN story TEXT"); } catch {} // groups tickets across repos on the hub board
  return db;
}
// ---- hub: <RIG_HOME>/.rig/hub.db, one per machine: the repos an orchestrator sees, and the messages meant for it
export function openHub() {
  const path = join(process.env.RIG_HOME ?? homedir(), ".rig", "hub.db");
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS repos(path TEXT PRIMARY KEY, name TEXT, manager TEXT, added TEXT);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, repo TEXT, ticket TEXT, frm TEXT, too TEXT, body TEXT,
      seen INTEGER DEFAULT 0, at TEXT);
    CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);`);
  return db;
}
// unread messages for `who`. wait: the listener; while it runs, nobody types into who's pane. A newer listener takes over.
async function readInbox(db: Database, who: string, wait: boolean) {
  const q = () => db.query("SELECT * FROM messages WHERE too=? AND seen=0 ORDER BY id").all(who) as any[];
  const key = `listener.${who}`;
  let msgs = q();
  if (wait) db.run("INSERT OR REPLACE INTO settings VALUES(?,?)", [key, String(process.pid)]);
  while (wait && !msgs.length) {
    await Bun.sleep(2000);
    // a newer listener took over: leave the messages to it instead of reading them here
    if ((db.query("SELECT v FROM settings WHERE k=?").get(key) as any)?.v !== String(process.pid)) return console.log("(replaced by a newer listener)");
    msgs = q();
  }
  for (const m of msgs) console.log(`${m.at} ${m.frm}${m.ticket ? ` [${m.ticket}]` : ""}: ${m.body}`);
  if (msgs.length) db.run(`UPDATE messages SET seen=1 WHERE id IN (${msgs.map(m => m.id).join(",")})`);
  else console.log("(empty)");
}
const repoName = (p: string) => p.split(/[\\/]/).pop()!;
const register = (root: string) => openHub().run("INSERT INTO repos(path, name, added) VALUES(?,?,?) ON CONFLICT(path) DO NOTHING", [root, repoName(root), now()]);

// codes above 107 are 256-color foregrounds (38;5;n)
const c = (code: number, t: string) => `\x1b[${code > 107 ? `38;5;${code}` : code}m${t}\x1b[0m`;
// board groups tickets by what they need from the person. Working sits high so a long Ready list can't push it
// off a half-height pane. Unknown statuses fall into To do.
const GROUPS: [string, string[], string, number][] = [ // title, statuses, dot, color
  ["Needs you", ["needs-you", "blocked"], "●", 31],
  ["Working", ["working", "reviewing"], "◐", 33],
  ["Ready", ["review"], "◆", 32],
  ["Queued", [], "◷", 90],
  ["To do", ["open", "draft"], "○", 37],
  ["Done", ["done"], "✓", 90],
];
// the tickets this one still waits on (its `after` list, minus what is done)
function waitingIn(db: Database, t: any): string[] {
  return String(t.after ?? "").split(/[,\s]+/).filter(Boolean)
    .filter(id => (db.query("SELECT status FROM tickets WHERE id=? COLLATE NOCASE").get(id) as any)?.status !== "done");
}
const groupIn = (db: Database, t: any) => (t.status === "open" || t.status === "draft") && waitingIn(db, t).length ? "Queued"
  : GROUPS.find(g => g[1].includes(t.status))?.[0] ?? "To do";
// every registered repo on one board: by story, then repo, then what each ticket needs. --all keeps done tickets.
// ponytail: reads each repo's DB directly, no live herdr status per run; open that repo's own board for that
function hubBoard(all: boolean) {
  const W = Math.max(30, (process.stdout.columns || 100) - 2);
  const fit = (s: string, n: number) => s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
  const rows: any[] = [];
  const hub = openHub(), repos = hub.query("SELECT * FROM repos ORDER BY name").all() as any[];
  hub.close(); // the live board calls this every 2s
  for (const r of repos) {
    if (!existsSync(join(r.path, ".rig", "rig.db"))) continue;
    const db = new Database(join(r.path, ".rig", "rig.db"), { readonly: true });
    for (const t of db.query("SELECT * FROM tickets ORDER BY created").all() as any[]) if (all || t.status !== "done") {
      const run = db.query("SELECT role, harness FROM runs WHERE ticket=? AND status='running' ORDER BY id DESC").get(t.id) as any;
      rows.push({ ...t, repo: r.path, name: r.name, group: GROUPS.findIndex(g => g[0] === groupIn(db, t)), run });
    }
    db.close();
  }
  let out = " " + c(1, c(214, "▲ rig")) + "  hub  " + c(90, new Date().toTimeString().slice(0, 5)) + "\n";
  if (!rows.length) return out + c(90, "   no open tickets in any registered repo\n");
  const stories = [...new Set(rows.map(t => t.story ?? ""))].sort((x, y) => !x ? 1 : !y ? -1 : x.localeCompare(y, undefined, { numeric: true }));
  for (const st of stories) {
    const head = `${st ? `STORY ${st}` : "NO STORY"} `;
    out += "\n " + c(1, head) + c(90, "─".repeat(Math.max(0, W - head.length))) + "\n";
    const mine = rows.filter(t => (t.story ?? "") === st);
    for (const repo of [...new Set(mine.map(t => t.repo))]) {
      out += "   " + c(1, c(117, mine.find(t => t.repo === repo).name)) + "\n";
      for (const t of mine.filter(t => t.repo === repo).sort((x, y) => x.group - y.group)) {
        const [, , dot, col] = GROUPS[t.group];
        const right = `${t.status}${t.run ? `  ${t.run.role} ${t.run.harness}` : ""}`;
        out += "   " + c(col, dot) + " " + fit(`${t.id}  ${t.title}`, W - right.length - 6).padEnd(W - right.length - 5) + c(90, right) + "\n";
      }
    }
  }
  return out;
}

// the hub board as data, for the herdr-app mod: each repo's own `board --json` (same cards, live status), regrouped by story
// ponytail: one rig process per repo per refresh (run in parallel); fine for a handful of repos
async function hubJson(hc: boolean) {
  const hub = openHub(), repos = hub.query("SELECT * FROM repos ORDER BY name").all() as any[];
  hub.close();
  const per = (await Promise.all(repos.filter(r => existsSync(join(r.path, ".rig", "rig.db"))).map(async r => {
    const p = Bun.spawn([process.execPath, import.meta.path, "board", "--json", ...(hc ? ["--hc"] : [])],
      { cwd: r.path, env: { ...process.env, RIG_ROOT: r.path, RIG_RUN: "" }, stdout: "pipe", stderr: "ignore", windowsHide: true });
    return { name: r.name, path: r.path, data: jsonOf(await new Response(p.stdout).text()) };
  }))).filter(r => r.data);
  const stories = [...new Set(per.flatMap(r => r.data.groups.flatMap((g: any) => g.tickets.map((t: any) => t.story ?? ""))))]
    .sort((x, y) => !x ? 1 : !y ? -1 : x.localeCompare(y, undefined, { numeric: true }));
  return { hub: true, stories: stories.map(st => ({ story: st || null, repos: per.map(r => ({ name: r.name, path: r.path,
    groups: r.data.groups.map((g: any) => ({ title: g.title, tickets: g.tickets.filter((t: any) => (t.story ?? "") === st) })).filter((g: any) => g.tickets.length) }))
    .filter(r => r.groups.length) })) };
}

// ---- terminal backend: herdr CLI (HERDR_PANE_ID) or herdr desktop app via hc + herdr-app (HC_TERMINAL_ID)
// --hc: the board mod runs rig from the app, which has no terminal env
const HC = !process.env.HERDR_PANE_ID && (!!process.env.HC_TERMINAL_ID || process.argv.includes("--hc"));
const SELF = process.env.HERDR_PANE_ID || process.env.HC_TERMINAL_ID || "";
// hc reports status as a word, or as {app, state} when a harness plugin reports it
const word = (s: any): string | undefined => typeof s === "string" ? s : s?.state;
// herdr CLI: a pane is gone only when herdr says so; a busy or timed-out herdr call is not a closed pane
const paneGone = (p: string) => { const r = sh(["herdr", "pane", "get", p]); return !r.ok && /pane_not_found/.test(r.out + r.err); };
const hcGet = (t: string) => { const r = sh(["hc", "get", t, "--json"]); try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; } };
export const mux = HC ? {
  push: (t: string, text: string) => sh(["hc", "send", t, text]).ok,
  status: (t: string) => { const g = hcGet(t); return g?.state !== "live" ? "gone" : word(g.status) ?? "running"; },
  read: (t: string, n: number) => sh(["hc", "read", t, "--lines", String(n)]).out,
  // an interrupt early in a turn can be ignored (opencode), so try once more when it says it did nothing
  esc: (t: string) => {
    const once = () => { try { return JSON.parse(sh(["hc", "interrupt", t, "--json"]).out).outcome; } catch { return ""; } };
    return once() === "stopped" || once() === "stopped";
  },
  // "p…" is an app pane holding a mod (the board); hc can't see those, so trust it until a split on it fails
  alive: (t: string) => t.startsWith("p") || hcGet(t)?.state === "live",
  focused: (t: string) => {
    try {
      const f = JSON.parse(sh(["herdr-app", "status"]).out).focused_pane;
      if (!f) return false;
      for (const sp of JSON.parse(sh(["herdr-app", "ls"]).out).spaces) for (const tb of sp.tabs) for (const x of tb.terminals)
        if (x.terminal === t) return x.pane === f;
    } catch {}
    return false; // no app window: nobody is typing in it
  },
  close: (t: string) => { if (t.startsWith("p")) return void sh(["herdr-app", "do", "pane.close", "--pane", t]); sh(["hc", "kill", t]); sh(["hc", "rm", t]); },
  notify: (title: string, body: string) => {}, // ponytail: no toast API in herdr-app yet; the message is stored and shows on the board
  // place it next to the manager (its own space/pane), not wherever the person is looking now
  // cmd: a program, or { mod, props } for an app mod pane. Returns the terminal, or the pane for a mod.
  // opening must never move the person's view: put the selected space/tab and the focused pane back afterwards
  open(place: "right" | "down" | "tab" | "space", cwd: string, name: string, cmd: string[] | { mod: string, props: any }, anchor = SELF): string {
    let v: any; try { v = JSON.parse(sh(["herdr-app", "status"]).out); } catch {}
    try { return this.open_(place, cwd, name, cmd, anchor); } finally {
      try {
        const n = JSON.parse(sh(["herdr-app", "status"]).out);
        if (v?.space && n.space !== v.space) sh(["herdr-app", "do", "space.select", "--id", v.space]);
        if (v?.tab && n.tab !== v.tab) sh(["herdr-app", "do", "tab.select", "--id", v.tab]);
        if (v?.focused_pane && n.focused_pane !== v.focused_pane) sh(["herdr-app", "do", "pane.focus", "--pane", v.focused_pane]);
      } catch {}
    }
  },
  // the ticket's space: the space of this terminal goes with all its terminals (the worker and a reviewer beside it)
  closeSpace: (t: string) => {
    try { for (const sp of JSON.parse(sh(["herdr-app", "ls"]).out).spaces) if (sp.tabs.some((tb: any) => tb.terminals.some((x: any) => x.terminal === t)))
      sh(["herdr-app", "do", "space.close", "--id", sp.id, "--confirmed", "true"]); } catch {}
  },
  open_(place: "right" | "down" | "tab" | "space", cwd: string, name: string, cmd: string[] | { mod: string, props: any }, anchor = SELF): string {
    let at: { space?: string, pane: string } | undefined = anchor.startsWith("p") ? { pane: anchor } : undefined;
    try { for (const sp of JSON.parse(sh(["herdr-app", "ls"]).out).spaces) for (const tb of sp.tabs) for (const t of tb.terminals)
      if (t.terminal === anchor) at = { space: sp.id, pane: t.pane }; } catch {}
    if (!Array.isArray(cmd)) {
      const r = sh(["herdr-app", "do", place === "tab" ? "tab.new" : "pane.split", JSON.stringify(place === "tab"
        ? { name, mod: cmd.mod, props: cmd.props } : { direction: place, ...(at ? { pane: at.pane } : {}), mod: cmd.mod, props: cmd.props })]);
      const p = r.ok ? JSON.parse(r.out).pane : undefined;
      if (!p && anchor !== SELF) return this.open_(place === "down" ? "right" : place, cwd, name, cmd);
      return p ?? die(`herdr-app: ${r.err || r.out}`);
    }
    // pane.split has no folder arg, so _exec cds then runs the agent
    const r = place === "space" ? sh(["herdr-app", "do", "space.new", "--name", name, "--folder", cwd, "--argv", JSON.stringify(cmd)])
      : place === "tab"
      ? sh(["herdr-app", "do", "tab.new", "--name", name, "--folder", cwd, "--argv", JSON.stringify(cmd), ...(at ? ["--space", at.space] : [])])
      : at ? sh(["herdr-app", "do", "pane.split", "--direction", place, "--pane", at.pane, "--argv", JSON.stringify([process.execPath, import.meta.path, "_exec", cwd, ...cmd])])
      : sh(["herdr-app", "do", "terminal.open", "--folder", cwd, "--place", place, "--argv", JSON.stringify(cmd)]);
    const t = r.ok ? JSON.parse(r.out).terminal : undefined;
    if (!t && anchor !== SELF) return this.open_(place === "down" ? "right" : place, cwd, name, cmd); // anchor gone: start beside the manager
    return t ?? die(`herdr-app: ${r.err || r.out}`);
  },
  /** wait until the agent works then settles; returns its status, or null when the terminal is gone */
  // wait until the agent settles after turn `after`; returns [status, turn], or null when the terminal is gone.
  // The caller starts at 0: with the prompt given at launch, turn 1 may begin before anyone looks.
  async settle(t: string, after = 0): Promise<[string, number] | null> {
    const turn0 = after;
    for (;;) {
      const w = sh(["hc", "wait", t, "--json", "--timeout", "600"]);
      let j: any = null; try { j = w.ok ? JSON.parse(w.out) : null; } catch {}
      // "ended" only means the wait ended (often reason "status"). The program exited only when there is an exit code
      // or signal, or the terminal is no longer live. A failed wait is not an exit either.
      const gone = () => hcGet(t)?.state !== "live";
      if (!j) { if (gone()) return null; await Bun.sleep(3000); continue; }
      if (j.exit_code != null || j.signal != null || gone()) return null;
      const st = word(j.status);
      if (st === "blocked" || st === "error" || (j.turn > turn0 && j.reason !== "timeout")) return [st ?? "idle", j.turn ?? turn0];
      await Bun.sleep(3000); // ponytail: idle before any new turn returns at once; poll 3s until a turn advances
    }
  },
} : {
  push: (p: string, text: string) => sh(["herdr", "agent", "prompt", p, text]).ok || sh(["herdr", "pane", "run", p, text]).ok,
  status: (p: string) => { // a pane herdr hasn't detected an agent in yet is still there, so "unknown", not "gone"
    const a = sh(["herdr", "agent", "get", p]);
    return a.ok ? JSON.parse(a.out).result.agent.agent_status ?? "unknown" : paneGone(p) ? "gone" : "unknown";
  },
  // what is on screen now; history can only be read while idle, and a blocked agent is the one worth reading
  read: (p: string, n: number) => sh(["herdr", "pane", "read", p, "--source", "visible", "--lines", String(n)]).out,
  esc: (p: string) => sh(["herdr", "agent", "send-keys", p, "esc"]),
  alive: (p: string) => !paneGone(p),
  focused: (p: string) => /"focused"\s*:\s*true/.test(sh(["herdr", "pane", "get", p]).out),
  close: (p: string) => sh(["herdr", "pane", "close", p]), // the last pane of a tab closes the tab
  closeSpace: (p: string) => { const w = deep(jsonOf(sh(["herdr", "pane", "get", p]).out), "workspace_id"); if (w) sh(["herdr", "workspace", "close", w]); },
  notify: (title: string, body: string) => sh(["herdr", "notification", "show", title, "--body", body, "--sound", "request"]),
  open: (..._: any[]): string => die("herdr: open is inline in dispatch"),
  async settle(p: string, after = 0): Promise<[string, number] | null> {
    // state_change_seq is herdr's turn counter, so a turn too short to catch as "working" still counts.
    // First call: an agent already settled at launch doesn't count. Only a gone pane means it exited.
    // ponytail: 3s poll; herdr agent wait has no "after seq" option
    // an agent blips idle between tool calls, so a settle counts only when the same seq holds for two polls
    // A herdr pane outlives its agent (it drops back to the shell), so an agent that was there and is gone has exited.
    let base = after, last = -1, seen = after > 0;
    for (;;) {
      const g = sh(["herdr", "agent", "get", p]);
      if (!g.ok) { if ((seen && /agent_not_found/.test(g.out + g.err)) || paneGone(p)) return null; await Bun.sleep(3000); continue; }
      seen = true;
      const a = JSON.parse(g.out).result.agent, st = a.agent_status, seq = a.state_change_seq ?? 0;
      const settled = st === "idle" || st === "blocked" || st === "done";
      if (!base) base = settled ? seq : -1;
      if (settled && seq > base && seq === last) return [st, seq];
      last = settled ? seq : -1;
      await Bun.sleep(3000);
    }
  },
};

const DEFAULTS: Record<string, string> = {
  "worker.harness": "claude", "worker.model": "", "worker.effort": "", "reviewer.harness": "codex", "reviewer.model": "", "reviewer.effort": "",
  merge: "local", setup: "",
  mode: "pane", worktree: "on", autonomy: "review", "pane.max": "2", "tab.max": "8", board: "auto",
};


async function main(args: string[]) {
  if (args[0] === "_exec") { // pane.split helper (hc): run argv in a folder; before parseArgs so the agent keeps its flags
    const p = Bun.spawn(args.slice(2), { cwd: args[1], stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await p.exited);
  }
  const { values: o, positionals: [cmd, ...pos] } = parseArgs({ args, allowPositionals: true, strict: false, options: {
    body: { type: "string" }, of: { type: "string" }, after: { type: "string" }, base: { type: "string" }, story: { type: "string" }, brief: { type: "string" }, hub: { type: "boolean" }, role: { type: "string" }, harness: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
    mode: { type: "string" }, worktree: { type: "string" }, "no-worktree": { type: "boolean" }, review: { type: "boolean" }, now: { type: "boolean" },
    mine: { type: "boolean" }, all: { type: "boolean" }, wait: { type: "boolean" }, open: { type: "boolean" },
    tab: { type: "boolean" }, once: { type: "boolean" }, force: { type: "boolean" }, json: { type: "boolean" }, tui: { type: "boolean" } } });
  if (!cmd || cmd === "help") return console.log(HELP);
  if (cmd === "skill") return console.log(readFileSync(join(SKILLS, pos[0] ?? "manager", "SKILL.md"), "utf8"));
  if (cmd === "install") return install(pos);
  if (cmd === "update") { // a git checkout (bun link) pulls; an install from GitHub reinstalls. Skills follow on their own.
    const git = existsSync(join(import.meta.dir, ".git"));
    const p = Bun.spawnSync(git ? ["git", "-C", import.meta.dir, "pull", "--ff-only"] : [process.execPath, "add", "-g", "github:zanuartri/herdr-rig"],
      { stdio: ["ignore", "inherit", "inherit"] });
    if (p.exitCode) process.exit(p.exitCode);
    // the board mod is a copy, so refresh it where the desktop app has it
    if (existsSync(join(APP_HOME(), "mods", "rig-board"))) Bun.spawnSync(["rig", "install", "herdr-app"], { stdio: ["ignore", "ignore", "inherit"] });
    return console.log(`rig is up to date (${JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")).version})`);
  }

  // the orchestrator's commands: they work from any folder, not only inside a repo
  if (cmd === "board" && o.hub && o.json) return console.log(JSON.stringify(await hubJson(HC)));
  if (cmd === "board" && o.hub && (o.open || o.tab)) { // beside this pane (or a tab): the app mod when installed, else the terminal board
    const cwd = process.cwd(), tab = !!o.tab;
    if (HC && !o.tui && existsSync(join(APP_HOME(), "mods", "rig-board", "main.js")))
      return console.log(mux.open(tab ? "tab" : "right", cwd, "rig hub", { mod: "rig-board", props: { rig: import.meta.path.replace(/\\/g, "/"), root: cwd.replace(/\\/g, "/"), bun: process.execPath, hub: true } }));
    if (HC) return console.log(mux.open(tab ? "tab" : "right", cwd, "rig hub", [process.execPath, import.meta.path, "board", "--hub"]));
    const made = tab ? sh(["herdr", "tab", "create", "--cwd", cwd, "--label", "rig hub", "--no-focus"])
      : sh(["herdr", "pane", "split", "--current", "--direction", "right", "--ratio", "0.5", "--cwd", cwd, "--no-focus"]);
    if (!made.ok) die(`herdr: ${made.err || made.out}`);
    const res = JSON.parse(made.out).result, pane = (tab ? res.root_pane : res.pane).pane_id;
    sh(["herdr", "pane", "run", pane, "rig board --hub"]);
    return console.log(pane);
  }
  if (cmd === "board" && o.hub) for (let first = true; ; first = false) {
    const text = hubBoard(!!o.all);
    process.stdout.write(o.once ? text : (first ? "\x1b[2J" : "") + "\x1b[H" + text.replace(/\n/g, "\x1b[K\n") + "\x1b[J");
    if (o.once) return;
    await Bun.sleep(2000);
  }
  if (cmd === "_launch") { // a herdr pane runs this: start the argv rig launch stored, in the foreground
    const hub = openHub(), k = `launch.${pos[0]}`;
    const cmdv = JSON.parse((hub.query("SELECT v FROM settings WHERE k=?").get(k) as any)?.v ?? die(`no launch ${pos[0]}`));
    hub.run("DELETE FROM settings WHERE k=?", [k]); hub.close();
    const p = Bun.spawn([...bin(cmdv[0]), ...cmdv.slice(1)], { stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await p.exited);
  }
  if (cmd === "launch") {
    if (pos[0] && !existsSync(pos[0])) die(`no folder ${pos[0]}`);
    const g = sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], pos[0] ?? die("usage: rig launch <repo path> --brief <file> [--harness h] [--model m] [--effort e] [--mode tab|pane]"));
    if (!g.ok) die(`${pos[0]} is not a git repo`);
    const root = dirname(g.out), name = repoName(root);
    const brief = resolve((o.brief as string) ?? die("--brief <file> is required"));
    if (!existsSync(brief)) die(`no brief at ${brief}`);
    const hname = (o.harness as string) ?? "claude";
    const h = HARNESSES[hname] ?? die(`unknown harness ${hname}`); // ponytail: built-ins only; per-repo harness.<name> overrides are not read here
    const sid = crypto.randomUUID(), orch = SELF || "local", pane_ = o.mode === "pane";
    const { prompt, cmd: cmdv } = launchCmd(h, brief, (o.model as string) ?? "", (o.effort as string) ?? "", sid);
    let pane: string;
    if (HC) { // herdr-app opens argv with no env, so RIG_ORCH rides in front of it (the prompt says the same on Windows)
      pane = mux.open(pane_ ? "right" : "tab", root, `${name} manager`,
        [...(process.platform === "win32" ? [] : ["env", `RIG_ORCH=${orch}`]), ...bin(cmdv[0]), ...cmdv.slice(1)]);
      if (!h.launch) { if (h.kind) sh(["hc", "wait", pane, "--timeout", "60"]); else await Bun.sleep(8000); mux.push(pane, prompt); }
    } else {
      const made = pane_ ? sh(["herdr", "pane", "split", ...(SELF ? ["--pane", SELF] : ["--current"]), "--direction", "right", "--ratio", "0.5", "--cwd", root, "--env", `RIG_ORCH=${orch}`, "--no-focus"])
        : sh(["herdr", "tab", "create", "--cwd", root, "--label", `${name} manager`, "--env", `RIG_ORCH=${orch}`, "--no-focus"]);
      if (!made.ok) die(`herdr: ${made.err || made.out}`);
      const res = JSON.parse(made.out).result;
      pane = (pane_ ? res.pane.pane_id : deep(res, "root_pane")?.pane_id ?? deep(res, "pane_id")) as string;
      if (h.kind) {
        const s = sh(["herdr", "agent", "start", `${name}-manager-${sid.slice(0, 4)}`.toLowerCase(), "--kind", h.kind, "--pane", pane,
          "--timeout", h.launch ? "15000" : "60000", "--", ...cmdv.slice(1)]);
        if (!s.ok && !h.launch) { mux.close(pane); die(`herdr agent start: ${s.err || s.out}`); }
        if (!s.ok) console.log(`rig: ${hname} is still starting in pane ${pane} (a startup dialog, like folder trust, may need an answer)`);
        if (!h.launch) mux.push(pane, prompt);
      } else { // no herdr agent kind: the pane's shell runs it, then the prompt is typed once it reads idle (60s cap)
        // the shell only types `rig _launch <sid>`; the argv waits in the hub, so no shell quoting (same as dispatch's _pane)
        openHub().run("INSERT OR REPLACE INTO settings VALUES(?,?)", [`launch.${sid}`, JSON.stringify(cmdv)]);
        if (!sh(["herdr", "pane", "run", pane, `rig _launch ${sid}`]).ok) { mux.close(pane); die(`herdr: couldn't start ${hname} in pane ${pane}`); }
        for (let i = 0; i < 60 && !/"agent_status":"idle"/.test(sh(["herdr", "agent", "get", pane]).out); i++) await Bun.sleep(1000);
        await Bun.sleep(1000);
        sh(["herdr", "pane", "send-text", pane, prompt]); sh(["herdr", "pane", "send-keys", pane, "enter"]);
      }
    }
    register(root);
    openHub().run("UPDATE repos SET manager=? WHERE path=?", [pane, root]);
    return console.log(`manager for ${name} in ${HC ? "terminal" : "pane"} ${pane}`);
  }
  if (cmd === "inbox" && o.hub) return readInbox(openHub(), "orchestrator", !!o.wait);
  if (cmd === "tell" && /:manager$/.test(pos[0] ?? "")) { // <repo name or path>:manager → that repo's manager pane
    const name = pos[0].slice(0, -":manager".length);
    const rows = openHub().query("SELECT * FROM repos WHERE name=? OR path=?").all(name, name) as any[];
    if (rows.length !== 1) die(rows.length ? `${name} names ${rows.length} repos; use its path` : `no repo ${name} in the hub (rig new or rig launch adds it)`);
    if (!rows[0].manager) die(`${name} has no manager yet; start one with rig launch`);
    if (!existsSync(join(rows[0].path, ".rig", "rig.db"))) die(`${rows[0].path} has no rig state any more (moved or deleted?)`);
    process.env.RIG_ROOT = rows[0].path;
    delete process.env.RIG_RUN; // the orchestrator's own run id means nothing in that repo
    return main(["_hubtell", `manager:${rows[0].manager}`, ...pos.slice(1)]);
  }

  if (["ls", "new", "dispatch"].includes(cmd) && !process.env.RIG_RUN) await updateNotice();
  const root = repoRoot();
  const dir = join(root, ".rig");
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, ".gitignore"), "*\n"); }
  const db = open(join(dir, "rig.db"));
  const get = (k: string) => (db.query("SELECT v FROM settings WHERE k=?").get(k) as any)?.v ?? DEFAULTS[k];
  const harness = (name: string) => {
    const over = get(`harness.${name}`);
    return over ? JSON.parse(over) : HARNESSES[name] ?? die(`unknown harness ${name} (set harness.${name} to a JSON template)`);
  };
  const ticket = (id?: string) => (db.query("SELECT * FROM tickets WHERE id=? COLLATE NOCASE").get(id ?? "") as any) ?? die(`no ticket ${id}`);
  // identity: workers carry RIG_RUN; a manager is its herdr pane
  const runIdEnv = process.env.RIG_RUN ?? (SELF ? (db.query("SELECT id FROM runs WHERE pane=? ORDER BY id DESC").get(SELF) as any)?.id : undefined);
  if (runIdEnv && !process.env.RIG_RUN) process.env.RIG_RUN = String(runIdEnv);
  const me = process.env.RIG_RUN ? whoRun(Number(process.env.RIG_RUN)) : `manager:${SELF || "local"}`;
  function whoRun(id: number) { const r = db.query("SELECT ticket, role FROM runs WHERE id=?").get(id) as any; return `${r.ticket}/${r.role}`; }
  const lastRun = (t: string, role?: string) => db.query(`SELECT * FROM runs WHERE ticket=? COLLATE NOCASE ${role ? "AND role=?" : ""}
    ORDER BY id DESC LIMIT 1`).get(...(role ? [t, role] : [t])) as any;
  // the board shows who is on a ticket now: its newest running run (a closed reviewer must not hide a working worker), else the last one
  const boardRun = (t: string) => (db.query("SELECT * FROM runs WHERE ticket=? COLLATE NOCASE AND status='running' ORDER BY id DESC LIMIT 1").get(t) as any) ?? lastRun(t);
  // a ticket means its worker (FIX findings and steering go there), even while a newer reviewer run exists;
  // --role reviewer or a run number picks another
  const runOf = (target: string) => (/^\d+$/.test(target) ? db.query("SELECT * FROM runs WHERE id=?").get(Number(target)) : lastRun(target, (o.role as string) ?? "worker")) as any
    ?? die(`no run for ${target}`);
  const kill = (pid: number) => process.platform === "win32"
    ? sh(["taskkill", "/T", "/F", "/PID", String(pid)]) : (() => { try { process.kill(-pid, "SIGTERM"); } catch {} })();

  const background = (sub: string, runId: number, cwd: string, asRun = true) => {
    const p = Bun.spawn([process.execPath, import.meta.path, sub, String(runId)], { cwd, env: { ...process.env, ...(asRun ? { RIG_RUN: String(runId) } : {}), RIG_ROOT: root },
      stdio: ["ignore", "ignore", "ignore"], detached: true, windowsHide: true });
    p.unref();
    return p.pid;
  };
  function spawnHeadless(runId: number, cmdv: string[], cwd: string) {
    db.run("UPDATE runs SET cmd=?, status='running' WHERE id=?", [JSON.stringify(cmdv), runId]);
    db.run("UPDATE runs SET pid=? WHERE id=?", [background("_run", runId, cwd), runId]);
  }
  const paneOf = (to: string) => to.startsWith("manager:") ? to.slice(8) : (() => {
    const [t, role] = to.split("/"); const r = lastRun(t, role); return r?.mode !== "headless" && r?.status === "running" ? r.pane : null;
  })();
  const listening = (who: string) => {
    const pid = Number(get(`listener.${who}`));
    try { return pid > 0 && (process.kill(pid, 0), true); } catch { return false; }
  };
  // the visible screen's last 12 lines with text: enough to see where an agent stopped, short enough to read
  const tail = (screen: string) => screen.split("\n").filter(l => l.trim()).slice(-12).join("\n");
  const pushText = (m: any) => `[rig] message from ${m.frm}${m.ticket ? ` on ${m.ticket}` : ""}: ${m.body} (rig inbox to mark read)`;
  function deliver(ticketId: string | null, to: string, body: string, frm = me) {
    // to myself (a manager's own command produced it): print it as output, never type it into my own pane
    if (to === me && frm === me) {
      db.run("INSERT INTO messages(ticket, frm, too, body, at, seen) VALUES(?,?,?,?,?,1)", [ticketId, me, to, body, now()]);
      return console.log(`rig: ${body}`);
    }
    const id = Number(db.run("INSERT INTO messages(ticket, frm, too, body, at) VALUES(?,?,?,?,?)", [ticketId, frm, to, body, now()]).lastInsertRowid);
    const pane = paneOf(to);
    if (!pane || pane === "local") return;
    if (listening(to)) return; // its `rig inbox --wait` picks it up within 2s
    // typing into a pane the person is focused on would send their unsent draft with it: hold it until they leave the pane
    if (mux.focused(pane)) return void background("_deliver", id, root, false);
    // typed into the pane = read: the next `rig inbox` must not hand it out again
    if (mux.push(pane, pushText({ frm, ticket: ticketId, body }))) db.run("UPDATE messages SET seen=1 WHERE id=?", [id]);
  }

  const ago = (at: string) => { const m = Math.round((Date.now() - Date.parse(at.replace(" ", "T") + "Z")) / 60000);
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  // harness colors on the terminal board, matching the app board
  const HUE256: Record<string, number> = { claude: 173, codex: 115, opencode: 111, pi: 141, omp: 205, commandcode: 116 };
  const waiting = (t: any) => waitingIn(db, t), groupOf = (t: any) => groupIn(db, t);
  // the settings that change how the manager behaves, shown under the board header
  const boardSettings = () => ({ autonomy: get("autonomy"), merge: get("merge"), worktree: get("worktree"), mode: get("mode"),
    worker: [get("worker.harness"), get("worker.model"), get("worker.effort")].filter(Boolean).join(" "),
    reviewer: [get("reviewer.harness"), get("reviewer.model"), get("reviewer.effort")].filter(Boolean).join(" ") });
  // the same board as data, for the herdr-app mod (mods/rig-board)
  function boardJson() {
    const tickets = db.query(`SELECT * FROM tickets ${o.mine ? "WHERE manager=?" : ""} ORDER BY created`).all(...(o.mine ? [(o.of as string) ?? me] : [])) as any[];
    // count is the whole group; tickets may be cut (Done sends only its last 5 unless --all)
    return { settings: boardSettings(), repo: root.split(/[\\/]/).pop(), groups: GROUPS.map(([title]) => ({ title,
      count: tickets.filter(t => groupOf(t) === title).length, tickets: tickets
      .filter(t => groupOf(t) === title)
      .slice(title === "Done" && !o.all ? -5 : 0)
      .map(t => {
        const r = title === "Done" ? null : boardRun(t.id);
        const live = r ? (r.mode === "headless" ? r.status : mux.status(r.pane)) : "";
        const m = title === "Done" ? null : db.query("SELECT * FROM messages WHERE ticket=? ORDER BY id DESC LIMIT 1").get(t.id) as any;
        // what the agent is doing: its terminal title (agents set it to their current task), else the last message
        const doing = HC && r?.pane && live !== "gone" ? (hcGet(r.pane)?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "") : "";
        const wait = waiting(t).map(id => `${id} (${(db.query("SELECT status FROM tickets WHERE id=? COLLATE NOCASE").get(id) as any)?.status ?? "missing"})`);
        return { id: t.id, title: t.title, status: t.status, story: t.story ?? null, manager: t.manager, waiting: wait, branch: t.branch ?? null, orphan: title === "Working" && !(r && live !== "gone" && r.status === "running"),
          run: r && live !== "gone" ? { role: r.role, harness: r.harness, model: r.model, effort: r.effort, mode: r.mode, pane: r.pane, live, started: r.started } : null,
          note: wait.length && title === "Queued" ? `waiting on ${wait.join(", ")}` : doing || (m ? m.body.split("\n")[0].replace(/^\[\w+\]\s*/, "") : ""), noteAt: m?.at ?? null };
      }) })) };
  }
  // the live board redraws every 120ms so its spinner moves; herdr is asked about each agent at most every 2s
  const memo = new Map<string, [number, any]>();
  const cached = <T>(k: string, f: () => T): T => { const m = memo.get(k); if (m && Date.now() - m[0] < 2000) return m[1]; const v = f(); memo.set(k, [Date.now(), v]); return v; };
  function board() {
    const W = Math.max(30, (process.stdout.columns || 100) - 2);
    const fit = (s: string, n: number) => s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
    const row = (left: string, right: string, n = W - 2) => fit(left, n - right.length - 1).padEnd(n - right.length) + right;
    const tickets = db.query(`SELECT * FROM tickets ${o.mine ? "WHERE manager=?" : ""} ORDER BY created`).all(...(o.mine ? [(o.of as string) ?? me] : [])) as any[];
    const groups = GROUPS.map(([title, , dot, col]) => ({ title, dot, col,
      rows: tickets.filter(t => groupOf(t) === title) }));
    const time = new Date().toTimeString().slice(0, 5);
    // brand: the rig tower glyph and "rig" in rig amber (256-color 214), same as the app board
    const repo = root.split(/[\\/]/).pop();
    let out = " " + row(`▲ rig  ${repo}`, time).replace("▲ rig", c(1, c(214, "▲ rig"))) + "\n ";
    out += groups.filter(g => g.rows.length).map(g => c(g.col, `${g.dot} ${g.rows.length} ${g.title.toLowerCase()}`)).join("   ") + "\n";
    // the settings that change how the manager works, as short chips; harness names in their colors
    const st = boardSettings();
    const auto = ({ ask: "ask each ticket", review: "merge on yes", merge: "auto-merge" } as any)[st.autonomy] ?? st.autonomy;
    const who = (h: string) => h.split(" ")[0];
    const chips: [string, string][] = [
      [`${auto} · ${st.merge === "pr" ? "PR" : "local"}`, ""], [st.worktree === "on" ? "worktree" : st.worktree === "herdr" ? "worktree space" : "no worktree", ""], [st.mode, ""],
      ...(st.worker ? [[`${who(st.worker)} → ${who(st.reviewer)}`, c(HUE256[who(st.worker)] ?? 252, who(st.worker)) + c(90, " → ") + c(HUE256[who(st.reviewer)] ?? 252, who(st.reviewer))] as [string, string]] : []),
    ];
    let line = "", used = 0;
    for (const [p, col] of chips) { if (used + p.length + 3 > W - 1) break; line += (line ? c(90, " · ") : "") + (col || c(90, p)); used += p.length + 3; }
    out += " " + line + "\n";
    for (const g of groups) {
      if (!g.rows.length) continue;
      // Working always in full; Needs you, Ready, Done show 3 and To do 5; --all shows everything
      const cap = o.all || g.title === "Working" ? Infinity : g.title === "To do" ? 5 : 3;
      const rows = g.title === "Done" ? g.rows.slice(-Math.min(cap, g.rows.length)) : g.rows.slice(0, cap);
      const head = `${g.title.toUpperCase()} ${g.rows.length} `;
      out += "\n " + c(g.col, c(1, head)) + c(90, "─".repeat(Math.max(0, W - head.length))) + "\n";
      for (const t of rows) {
        if (g.title === "Done") { out += " " + c(g.col, g.dot) + " " + c(90, fit(`${t.id}  ${t.title}`, W - 2)) + "\n"; continue; }
        const r = boardRun(t.id);
        const live = r ? (r.mode === "headless" ? r.status : cached(`s${r.pane}`, () => mux.status(r.pane))) : "";
        const on = r && live !== "gone" && !String(live).startsWith("exited") && r.status === "running";
        // mark: ! when stuck (ticket blocked, or the agent blocked/errored), ? when it is a question
        const stuck = t.status === "blocked" || (g.title === "Working" && (!on || live === "blocked" || live === "error"));
        // a working agent spins (one frame per refresh)
        const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(Date.now() / 100) % 10];
        const mark = stuck ? c(31, c(1, "!")) : t.status === "needs-you" ? c(31, c(1, "?"))
          : g.title === "Working" && live === "working" ? c(214, spin) : c(g.col, g.dot);
        // line 1: id and title, age on the right
        out += " " + mark + " " + row(`${t.id}  ${t.title}`, ago(r?.started ?? t.created)).replace(t.id, c(1, t.id)) + "\n";
        // line 2: the note on the left; who is on it on the right (role, harness in its color, model, effort meter)
        const parts: [string, string][] = on ? [
          ...(stuck && g.title === "Working" ? [[live, c(31, live)] as [string, string]] : []),
          [r.role, c(r.role === "reviewer" ? 117 : 214, r.role)],
          [r.harness, c(1, c(HUE256[r.harness] ?? 252, r.harness))],
          ...(r.model ? [[r.model.split("/").pop(), c(90, r.model.split("/").pop())] as [string, string]] : []),
          ...(r.effort ? [(() => { const n = ({ minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 } as any)[r.effort] ?? 2;
            const bar = "▮".repeat(n) + "▯".repeat(4 - n); return [`${bar} ${r.effort}`, c(33, "▮".repeat(n)) + c(90, "▯".repeat(4 - n) + " " + r.effort)] as [string, string]; })()] : []),
        ] : [];
        const plain = parts.map(p => p[0]).join("  "), colored = parts.map(p => p[1]).join("  ");
        const m = db.query("SELECT * FROM messages WHERE ticket=? ORDER BY id DESC LIMIT 1").get(t.id) as any;
        const doing = on && r.pane ? cached(`t${r.pane}`, () => titleOf(r.pane)) : "";
        const note = (t.branch ? `⎇ ${t.branch}  ` : "") + (g.title === "Queued" ? `waiting on ${waiting(t).join(", ")}`
          : doing ? `› ${doing}` : m ? m.body.split("\n")[0].replace(/^\[\w+\]\s*/, "") : "");
        // same right edge as line 1 (" " + mark + " " + W-2 columns)
        if (note || plain) out += "   " + c(90, fit(note, Math.max(0, W - 3 - plain.length)).padEnd(Math.max(0, W - 2 - plain.length))) + colored + "\n";
      }
      if (g.rows.length > rows.length) out += "   " + c(90, `+${g.rows.length - rows.length} more  (rig ls${g.title === "Done" ? " --all" : ""})`) + "\n";
    }
    // whatever height is left: the latest messages between the manager and its runs, newest first
    const left = (process.stdout.rows || 0) - out.split("\n").length - 3;
    if (!o.once && left >= 2) {
      const head = "ACTIVITY ";
      out += "\n " + c(90, c(1, head)) + c(90, "─".repeat(Math.max(0, W - head.length))) + "\n";
      const ids = new Set(tickets.map(t => t.id));
      const msgs = (db.query("SELECT * FROM messages ORDER BY id DESC LIMIT 50").all() as any[]).filter(m => ids.has(m.ticket)).slice(0, left);
      for (const m of msgs) {
        const from = m.frm.startsWith("manager") ? "manager" : m.frm.split("/").pop();
        const hhmm = new Date(m.at.replace(" ", "T") + "Z").toTimeString().slice(0, 5); // stored in UTC
        const tag = `${hhmm}  ${m.ticket} ${from}  `;
        const col = from === "reviewer" ? 117 : from === "manager" ? 252 : 214;
        out += " " + c(90, hhmm) + "  " + c(1, m.ticket) + " " + c(col, from) + "  "
          + c(90, fit(m.body.split("\n")[0].replace(/^\[\w+\]\s*/, ""), W - tag.length - 1)) + "\n";
      }
    }
    return out;
  }
  // what an agent says it is doing: its terminal title (agents set it to their current task)
  const titleOf = (p: string): string => {
    const t = HC ? hcGet(p)?.title : (() => { const a = sh(["herdr", "agent", "get", p]); try { return a.ok ? JSON.parse(a.out).result.agent.terminal_title_stripped : ""; } catch { return ""; } })();
    const s = String(t ?? "").replace(/^[^\p{L}\p{N}]+/u, "");
    // a title that is only the agent's name and the ticket says nothing; the last message says more
    return s.replace(/T-\d+|[^\p{L}]/gu, "").length < 8 ? "" : s;
  };

  // the right column beside this manager: its board (if open), then its live pane runs, top to bottom
  const column = (skipRun = 0) => [get(`board.${me}`), ...(db.query(`SELECT r.pane FROM runs r JOIN tickets t ON t.id=r.ticket
    WHERE r.mode='pane' AND r.status <> 'closed' AND t.manager=? AND r.id<>? ORDER BY r.id`).all(me, skipRun) as any[]).map(r => r.pane)]
    .filter(p => p && mux.alive(p)) as string[];
  // board: top half of the right column, beside the manager. Workers then split it down, so it keeps 50%.
  function openBoard(tab = false) {
    const below = tab ? undefined : column().at(-1);
    // the board runs in its own pane, so it is told whose tickets "mine" means
    const cmdv = [process.execPath, import.meta.path, "board", ...(o.mine ? ["--mine", "--of", me] : [])];
    // desktop: the native mod when installed, unless the person picked the terminal board (board=tui or --tui)
    const native = HC && !o.tui && get("board") !== "tui" && existsSync(join(APP_HOME(), "mods", "rig-board", "main.js"));
    let pane: string;
    if (native) pane = mux.open(tab ? "tab" : below ? "down" : "right", root, "rig board",
      { mod: "rig-board", props: { rig: import.meta.path.replace(/\\/g, "/"), root: root.replace(/\\/g, "/"), bun: process.execPath } }, below);
    else if (HC) pane = mux.open(tab ? "tab" : below ? "down" : "right", root, "rig board", cmdv, below);
    else {
      const made = tab ? sh(["herdr", "tab", "create", "--cwd", root, "--label", "rig board", "--no-focus"])
        : sh(["herdr", "pane", "split", ...(below ? ["--pane", below, "--direction", "down"] : ["--current", "--direction", "right", "--ratio", "0.5"]),
          "--cwd", root, "--no-focus"]);
      if (!made.ok) die(`herdr: ${made.err || made.out}`);
      const res = JSON.parse(made.out).result;
      pane = (tab ? res.root_pane : res.pane).pane_id;
      sh(["herdr", "pane", "run", pane, `rig board${o.mine ? ` --mine --of ${me}` : ""}`]);
    }
    if (!tab) db.run("INSERT OR REPLACE INTO settings VALUES(?,?)", [`board.${me}`, pane]);
    return pane;
  }
  // a ticket starts from and lands on its base: --base, else the branch the manager had checked out when it was made
  const here = () => { const b = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"]).out; return b && b !== "HEAD" ? b : sh(["git", "rev-parse", "HEAD"]).out; };
  const base = (t: any) => t.base || here();
  // a done ticket's worktree goes once its branch has landed on the ticket's base, so no work is lost.
  // Returns null when removed (or nothing to do), else why it was kept.
  function cleanWorktree(t: any, force = false): string | null {
    if (!t.worktree && !t.branch) return null;
    // "landed", not "merged": a squash merge leaves the branch unmerged, so check that every file the branch
    // changed is already the same on the base. True for normal and squash merges alike.
    const landed = () => {
      const mb = sh(["git", "merge-base", base(t), t.branch], root);
      if (!mb.ok) return false; // branch gone or unrelated
      const files = sh(["git", "diff", "--name-only", mb.out, t.branch], root).out.split("\n").filter(Boolean);
      return !files.length || sh(["git", "diff", "--quiet", t.branch, base(t), "--", ...files], root).ok;
    };
    const merged = t.branch ? landed() : true;
    if (!merged && !force) return `${t.branch} is not merged, worktree kept`;
    if (t.worktree) sh(["git", "worktree", "remove", "--force", t.worktree], root);
    // Windows keeps a folder a just-closed agent still held; git lets go of it, so remove what is left
    // ponytail: up to 5s of retries; a later rig clean sweeps what is still locked
    for (let i = 0; t.worktree && existsSync(t.worktree) && i < 10; i++) { try { rmSync(t.worktree, { recursive: true, force: true }); } catch { Bun.sleepSync(500); } }
    if (t.branch) sh(["git", "branch", "-D", t.branch], root);
    db.run("UPDATE tickets SET worktree=NULL, branch=NULL WHERE id=?", [t.id]);
    return null;
  }
  // a finished run gives its pane or tab back
  // a sandboxed manager (codex) can't reach herdr, and the close would fail silently
  const shut = (p: string) => { mux.close(p); if (mux.alive(p)) console.error(`rig: couldn't close ${p}. rig needs git and herdr, so run it outside your agent's sandbox.`); };
  const closeRuns = (ticketId: string) => {
    for (const r of db.query("SELECT * FROM runs WHERE ticket=? AND status <> 'closed'").all(ticketId) as any[]) {
      db.run("UPDATE runs SET status='closed' WHERE id=?", [r.id]); // first, so its watcher knows this was on purpose
      if (r.mode === "headless") { if (r.pid) kill(r.pid); }
      else if (r.pane && r.mode === "space") { mux.closeSpace(r.pane); if (mux.alive(r.pane)) shut(r.pane); } // the whole space; the next run of it finds it gone
      else if (r.pane) shut(r.pane);
    }
  };

  switch (cmd) {
    case "init": return console.log(`rig db: ${join(dir, "rig.db")}`);
    case "set": db.run("INSERT OR REPLACE INTO settings VALUES(?,?)", [pos[0], pos.slice(1).join(" ")]); return;
    case "get": {
      const rows = Object.fromEntries((db.query("SELECT k, v FROM settings").all() as any[]).map(r => [r.k, r.v]));
      const all = { ...DEFAULTS, ...rows };
      return console.log(pos[0] ? all[pos[0]] ?? "" : Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n"));
    }
    case "new": {
      if (!pos.join(" ").trim()) die('usage: rig new "title" [--body text|-]');
      // numbers are per repo, shared by every manager; IMMEDIATE takes the write lock first so two managers can't get the same one
      const body = o.body === "-" ? await Bun.stdin.text() : (o.body as string) ?? "";
      const n = db.transaction(() => {
        const n = ((db.query("SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) n FROM tickets").get() as any).n ?? 0) + 1;
        db.run("INSERT INTO tickets(id,title,body,manager,review,after,base,story,created) VALUES(?,?,?,?,?,?,?,?,?)",
          [`T-${n}`, pos.join(" "), body, me, o.review ? 1 : 0, (o.after as string) ?? null, (o.base as string) ?? here(), (o.story as string) ?? null, now()]);
        return n;
      }).immediate();
      register(root);
      return console.log(`T-${n}`);
    }
    case "edit": {
      const t = ticket(pos[0]);
      for (const kv of pos.slice(1)) {
        const [k, ...v] = kv.split("=");
        if (!["title", "body", "status", "review", "manager", "after", "base", "story"].includes(k)) die(`can't edit ${k}`);
        const was = k === "status" ? ticket(t.id).status : null; // re-read: an earlier status= in this same edit counts
        db.run(`UPDATE tickets SET ${k}=? WHERE id=?`, [v.join("="), t.id]);
        // a registered repo tells the orchestrator when a ticket needs a decision or is ready
        if (k === "status" && v.join("=") !== was && ["needs-you", "blocked", "review"].includes(v.join("="))) {
          const hub = openHub();
          // only once an orchestrator has listened, so a machine that never orchestrates collects nothing
          if (hub.query("SELECT 1 FROM repos WHERE path=?").get(root) && hub.query("SELECT 1 FROM settings WHERE k='listener.orchestrator'").get()) hub.run("INSERT INTO messages(repo, ticket, frm, too, body, at) VALUES(?,?,?,?,?,?)",
            [root, t.id, `${repoName(root)}:${t.id}`, "orchestrator", `${t.id} is ${v.join("=")}: ${t.title}`, now()]);
        }
        if (k === "status" && v.join("=") === "done") {
          closeRuns(t.id);
          const kept = cleanWorktree(t);
          if (kept) console.log(`rig: ${t.id} done; ${kept}. Keep it for a PR, or drop it with: rig clean ${t.id} --force`);
          // a ticket waiting only on finished work can start now; the manager decides when
          for (const d of db.query("SELECT * FROM tickets WHERE after LIKE ? AND status IN ('open','draft')").all(`%${t.id}%`) as any[])
            if (!waiting(d).length) deliver(d.id, d.manager, `${d.id} is unblocked: ${t.id} is done. Dispatch it when it suits.`);
        }
      }
      if (o.body !== undefined) db.run("UPDATE tickets SET body=? WHERE id=?", [o.body === "-" ? await Bun.stdin.text() : o.body, t.id]);
      return;
    }
    case "ls": {
      const rows = db.query(`SELECT * FROM tickets ${o.mine ? "WHERE manager=?" : ""} ORDER BY created`).all(...(o.mine ? [(o.of as string) ?? me] : [])) as any[];
      for (const t of rows) if (o.all || t.status !== "done") console.log(`${t.id}\t${t.status}\t${t.review ? "review\t" : "\t"}${t.title}`);
      return;
    }
    case "show": {
      const t = ticket(pos[0]);
      console.log(`# ${t.id}: ${t.title}\nstatus: ${t.status} · review: ${t.review ? "yes" : "no"} · manager: ${t.manager}${t.story ? ` · story: ${t.story}` : ""}`
        + `${t.worktree ? `\nworktree: ${t.worktree} (branch ${t.branch} from ${base(t)})` : ""}\n\n${t.body}\n`);
      const msgs = db.query("SELECT * FROM messages WHERE ticket=? ORDER BY id DESC LIMIT 20").all(t.id) as any[];
      if (msgs.length) console.log("## messages\n" + msgs.reverse().map(m => `${m.at} ${m.frm} → ${m.too}: ${m.body}`).join("\n"));
      const runs = db.query("SELECT * FROM runs WHERE ticket=? ORDER BY id").all(t.id) as any[];
      if (runs.length) console.log("\n## runs\n" + runs.map(r => `#${r.id} ${r.role} ${r.harness}${r.model ? ":" + r.model : ""} ${r.mode} ${r.status}`).join("\n"));
      return;
    }
    case "dispatch": {
      const t = ticket(pos[0]);
      const role = (o.role as string) ?? "worker";
      const hname = (o.harness as string) ?? get(`${role}.harness`);
      const h = harness(hname);
      // the role's default model/effort belong to its default harness; a --harness override starts from that harness's own
      const own = !o.harness || o.harness === get(`${role}.harness`);
      const model = (o.model as string) ?? (own ? get(`${role}.model`) : "") ?? "";
      const effort = (o.effort as string) ?? (own ? get(`${role}.effort`) : "") ?? "";
      let mode = (o.mode as string) ?? get("mode");
      let cwd = t.worktree ?? root;
      // worktree=herdr: the ticket gets a space of its own; a live worker there is what a reviewer splits beside
      const anchor = (db.query("SELECT pane FROM runs WHERE ticket=? AND mode='space' AND status <> 'closed' ORDER BY id DESC").all(t.id) as any[])
        .map(r => r.pane).find(p => p && mux.alive(p)) as string | undefined;
      const plan = worktreePlan(role, (o.worktree as string) ?? get("worktree"), !!o["no-worktree"], mode, !!t.worktree, !!anchor);
      const spaceName = `${t.id} ${t.title}`;
      let wtMade: ReturnType<typeof sh> | undefined; // herdr CLI: the reply of `herdr worktree create`, which also opens the space
      if (role === "worker" && !t.worktree && (plan.git || plan.space)) {
        cwd = join(dir, "wt", t.id).replace(/\\/g, "/");
        const branch = `rig/${t.id}`;
        if (plan.space && !HC) {
          wtMade = sh(["herdr", "worktree", "create", "--cwd", root, "--branch", branch, "--base", base(t), "--path", cwd, "--label", spaceName, "--no-focus"]);
          if (!wtMade.ok) die(`herdr worktree create: ${wtMade.err || wtMade.out}`);
        } else {
          const r = sh(["git", "worktree", "add", cwd, "-b", branch, base(t)], root);
          if (!r.ok && !existsSync(cwd)) die(r.err);
        }
        db.run("UPDATE tickets SET worktree=?, branch=? WHERE id=?", [cwd, branch, t.id]);
      }
      if (plan.space) mode = "space";
      const sid = crypto.randomUUID();
      const runId = Number(db.run("INSERT INTO runs(ticket,role,harness,model,effort,mode,sid,status,cwd,started) VALUES(?,?,?,?,?,?,?,'starting',?,?)",
        [t.id, role, hname, model, effort, mode, sid, cwd, now()]).lastInsertRowid);
      const env = { RIG_RUN: String(runId), RIG_ROOT: root };
      const extra = pos.slice(1).join(" ");
      const prompt = `You are the rig ${role} for ticket ${t.id}. Run \`rig skill ${role}\` and follow those instructions, then run \`rig show ${t.id}\`.`
        + (extra ? ` Note from the manager: ${extra}` : "");
      db.run("UPDATE tickets SET status=? WHERE id=?", [role === "worker" ? "working" : "reviewing", t.id]);

      // layout: manager left half; right column = board (top 50%) + pane.max runs under it (2 → 25% each); the rest go to tabs
      // ponytail: each split halves the last pane, so heights are only even up to pane.max=2
      // a space run leaves the manager's space with just the manager and the board
      let col = mode === "pane" ? column(runId) : [];
      if ((mode === "pane" || plan.space) && get("board") !== "off" && !column(runId).includes(get(`board.${me}`))) { openBoard(); col = mode === "pane" ? column(runId) : []; }
      let place: "tab" | "right" | "down" | "space" = plan.space ? (anchor ? "right" : "space") : mode === "tab" ? "tab" : col.at(-1) ? "down" : "right";
      let below = plan.space ? anchor : mode === "pane" ? col.at(-1) : undefined;
      if (mode === "pane" && col.length - (col.includes(get(`board.${me}`)) ? 1 : 0) >= Number(get("pane.max"))) {
        // overflow: fill the newest overflow tab (mode "over-N"), else open the next one
        const live = (db.query(`SELECT r.mode, r.pane FROM runs r JOIN tickets t ON t.id=r.ticket WHERE r.mode LIKE 'over-%' AND r.status <> 'closed'
          AND t.manager=? AND r.id<>? ORDER BY r.id`).all(me, runId) as any[]).filter(r => r.pane && mux.alive(r.pane));
        const last = db.query("SELECT mode FROM runs WHERE mode LIKE 'over-%' ORDER BY id DESC LIMIT 1").get() as any;
        let n = Number(last?.mode.slice(5) ?? 0), s = { place: "tab" } as ReturnType<typeof slot>;
        for (const k of new Set(live.map(r => r.mode)))
          if ((s = slot(live.filter(r => r.mode === k).map(r => r.pane), Number(get("tab.max")))).place !== "tab") { n = Number(k.slice(5)); break; }
        if (s.place === "tab") n++;
        mode = `over-${n}`; place = s.place; below = s.anchor;
        db.run("UPDATE runs SET mode=? WHERE id=?", [mode, runId]);
      }
      if (mode === "headless") { spawnHeadless(runId, argv(h, "headless", model, sid, prompt, effort), cwd); return console.log(`run #${runId} headless`); }

      if (HC) {
        const cmdv = argv(h, "interactive", model, sid, h.launch ? prompt : undefined, effort);
        const pane = mux.open(place, cwd, place === "space" ? spaceName : `${t.id} ${role}`, [...bin(cmdv[0]), ...cmdv.slice(1)], below);
        db.run("UPDATE runs SET pane=?, status='running' WHERE id=?", [pane, runId]);
        if (!h.launch) {
          // ponytail: agents settle to idle when ready; plain TUIs get a fixed 8s
          if (h.kind) sh(["hc", "wait", pane, "--timeout", "60"]); else await Bun.sleep(8000);
          mux.push(pane, prompt);
        }
        background("_watch", runId, cwd);
        return console.log(`run #${runId} in terminal ${pane}`);
      }
      const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
      // opening a space must not move the person's view: note the workspace they are in, and go back to it
      const viewing = plan.space ? deep(jsonOf(sh(["herdr", "pane", "get", SELF]).out), "workspace_id") : undefined;
      const made = wtMade ?? (place === "space" ? sh(["herdr", "workspace", "create", "--cwd", cwd, "--label", spaceName, ...envArgs, "--no-focus"])
        : place === "tab"
        ? sh(["herdr", "tab", "create", "--cwd", cwd, "--label", `${t.id} ${role}`, ...envArgs, "--no-focus"])
        : sh(["herdr", "pane", "split", ...(below ? ["--pane", below, "--direction", place] : ["--current", "--direction", "right", "--ratio", "0.5"]),
          "--cwd", cwd, ...envArgs, "--no-focus"]));
      if (viewing) sh(["herdr", "workspace", "focus", viewing]);
      if (!made.ok) die(`herdr: ${made.err || made.out}`);
      const res = JSON.parse(made.out).result;
      const pane = (place === "tab" || place === "space" ? deep(res, "root_pane")?.pane_id ?? deep(res, "pane_id") : res.pane.pane_id) as string;
      db.run("UPDATE runs SET pane=?, status='running' WHERE id=?", [pane, runId]);
      background("_watch", runId, cwd); // before the agent starts, so its first turn is watched too
      const cmdv = argv(h, "interactive", model, sid, h.launch ? prompt : undefined, effort);
      if (h.kind) {
        const s = sh(["herdr", "agent", "start", `${t.id}-${role}-${runId}`.toLowerCase(), "--kind", h.kind, "--pane", pane,
          // the prompt rides in argv, so only a prompt typed later needs the agent ready; keep dispatch quick otherwise
          "--timeout", h.launch ? "15000" : "60000", "--", ...cmdv.slice(1)]);
        // not ready yet: slow to load, or blocked on a dialog (folder trust, update) the person has to answer. The prompt
        // is in argv, so it goes on by itself; keep the pane, and the watcher reports if the agent dies instead.
        if (!s.ok && h.launch) {
          const blocked = /blocked/.test(s.out + s.err);
          if (blocked) mux.notify(`rig ${t.id}`, `${hname} ${role} is waiting on a startup dialog. Answer it in its pane.`);
          console.log(`rig: ${hname} is ${blocked ? "waiting on a startup dialog (folder trust?). Ask the user to answer it" : "still starting"} in pane ${pane}.`);
        } else if (!s.ok) { db.run("UPDATE runs SET status='failed' WHERE id=?", [runId]); mux.close(pane); die(`herdr agent start: ${s.err || s.out}`); }
        if (!h.launch) mux.push(pane, prompt);
      } else {
        // no herdr agent kind: herdr may still detect the TUI; wait until it reads idle (60s cap), then prompt
        // the pane's shell only types `rig _pane N`; the argv comes from the db, so no shell quoting
        db.run("UPDATE runs SET cmd=? WHERE id=?", [JSON.stringify(cmdv), runId]);
        sh(["herdr", "pane", "run", pane, `rig _pane ${runId}`]);
        for (let i = 0; i < 60 && !/"agent_status":"idle"/.test(sh(["herdr", "agent", "get", pane]).out); i++) await Bun.sleep(1000);
        await Bun.sleep(1000);
        sh(["herdr", "pane", "send-text", pane, prompt]); sh(["herdr", "pane", "send-keys", pane, "enter"]);
      }
      return console.log(`run #${runId} in pane ${pane}`);
    }
    case "_hubtell": return deliver(null, pos[0], pos.slice(1).join(" ") || die("message required"), "orchestrator");
    case "_pane": { // a herdr pane runs this: start the run's stored argv in the foreground
      const r = db.query("SELECT * FROM runs WHERE id=?").get(Number(pos[0])) as any;
      const p = Bun.spawn(JSON.parse(r.cmd), { cwd: r.cwd, stdio: ["inherit", "inherit", "inherit"] });
      process.exit(await p.exited);
    }
    case "_deliver": { // detached: push a held message once its pane loses focus, unless `rig inbox` read it first
      // ponytail: 2s focus poll, gives up after 12h (the message stays in the inbox)
      for (let i = 0; i < 21600; i++, await Bun.sleep(2000)) {
        const m = db.query("SELECT * FROM messages WHERE id=?").get(Number(pos[0])) as any;
        const pane = m && !m.seen ? paneOf(m.too) : null;
        if (!pane || !mux.alive(pane) || listening(m.too)) return;
        if (!mux.focused(pane)) {
          // everything still held for this pane goes in one push, so a burst of reports lands as one message.
          // The other held deliverers then find their message seen and stop.
          const held = db.query("SELECT * FROM messages WHERE too=? AND seen=0 ORDER BY id").all(m.too) as any[];
          const text = held.length === 1 ? pushText(m)
            : `[rig] ${held.length} messages while you were busy:\n` + held.map(h => `- ${h.frm}${h.ticket ? ` on ${h.ticket}` : ""}: ${h.body.split("\n")[0]}`).join("\n") + "\n(rig show <ticket> for the full text)";
          if (mux.push(pane, text)) db.run(`UPDATE messages SET seen=1 WHERE id IN (${held.map(h => h.id).join(",")})`);
          return;
        }
      }
      return;
    }
    case "_watch": { // detached, per pane run: when the agent settles without having reported, tell the manager. herdr does the waiting.
      let turn = 0, since = db.query("SELECT started FROM runs WHERE id=?").get(Number(pos[0])) as any;
      since = since?.started ?? now();
      for (;;) {
        const r = db.query("SELECT * FROM runs WHERE id=?").get(Number(pos[0])) as any;
        if (r?.status !== "running") return;
        const res = await mux.settle(r.pane, turn);
        const state = res?.[0];
        if (res) turn = res[1];
        if (!state) { // the agent exited or its pane closed. rig close marks the run first; anything else is a surprise
          const now2 = db.query("SELECT status FROM runs WHERE id=?").get(r.id) as any;
          if (now2?.status !== "running") return;
          db.run("UPDATE runs SET status='exited' WHERE id=?", [r.id]);
          const reported = db.query("SELECT 1 FROM messages WHERE frm=? AND at>=?").get(me, r.started);
          const screen = tail(mux.read(r.pane, 60));
          deliver(r.ticket, ticket(r.ticket).manager, `[watch] ${r.role} run #${r.id} exited${reported ? "" : " without reporting"}.`
            + (screen ? ` Last screen:\n${screen}` : ""));
          return;
        }
        const reported = db.query("SELECT 1 FROM messages WHERE frm=? AND at>=?").get(me, since);
        since = now(); // the next turn has to report again
        if (reported && state !== "blocked") continue;
        const screen = tail(mux.read(r.pane, 60));
        deliver(r.ticket, ticket(r.ticket).manager, `[watch] ${r.role} run #${r.id} is ${state} without reporting. Screen:\n${screen}`);
      }
    }
    case "_run": { // detached wrapper for headless runs: run the harness, log, tell the manager when it exits
      const r = db.query("SELECT * FROM runs WHERE id=?").get(Number(pos[0])) as any;
      const cmdv = JSON.parse(r.cmd);
      const log = openSync(join(dir, `run-${r.id}.log`), "a");
      const p = Bun.spawn([...bin(cmdv[0]), ...cmdv.slice(1)], { cwd: r.cwd, stdio: ["ignore", log, log], windowsHide: true });
      const code = await p.exited;
      db.run("UPDATE runs SET status=? WHERE id=?", [`exited ${code}`, r.id]);
      const tail = readFileSync(join(dir, `run-${r.id}.log`), "utf8").trim().split("\n").slice(-15).join("\n");
      const t = ticket(r.ticket);
      deliver(r.ticket, t.manager, `headless ${r.role} run #${r.id} exited (${code}). Last output:\n${tail}`);
      return;
    }
    case "tell": { // steer: pane → type into it (--now interrupts first); headless → interrupt + resume with the message
      const r = runOf(pos[0]);
      const msg = pos.slice(1).join(" ") || die("message required");
      db.run("INSERT INTO messages(ticket, frm, too, body, at) VALUES(?,?,?,?,?)", [r.ticket, me, `${r.ticket}/${r.role}`, `[steer] ${msg}`, now()]);
      // a worker being told something is back at work (e.g. reviewer findings), so the board shows it in Working
      if (r.role === "worker" && ["review", "needs-you", "blocked"].includes(ticket(r.ticket).status)) db.run("UPDATE tickets SET status='working' WHERE id=?", [r.ticket]);
      if (r.mode !== "headless") {
        if (o.now) { mux.esc(r.pane); await Bun.sleep(500); }
        return void mux.push(r.pane, msg);
      }
      if (r.status === "running" && r.pid) kill(r.pid);
      spawnHeadless(r.id, argv(harness(r.harness), "resume", r.model, r.sid, msg, r.effort ?? ""), r.cwd);
      return console.log(`run #${r.id} resumed`);
    }
    case "clean": { // worktrees of done tickets: drop the merged ones (or one ticket, --force for unmerged), then prune
      const list = pos[0] ? [ticket(pos[0])] : db.query("SELECT * FROM tickets WHERE status='done' AND worktree IS NOT NULL").all() as any[];
      for (const t of list) { const kept = cleanWorktree(t, !!o.force); console.log(`${t.id}: ${kept ?? "worktree and branch removed"}`); }
      sh(["git", "worktree", "prune"], root);
      // folders a still-running process held when their worktree was removed (Windows locks a cwd)
      const live = sh(["git", "worktree", "list", "--porcelain"], root).out.replace(/\\/g, "/").split("\n");
      const wt = join(dir, "wt");
      if (existsSync(wt)) for (const f of readdirSync(wt)) if (!live.some(l => l.endsWith(`/wt/${f}`)))
        try { rmSync(join(wt, f), { recursive: true, force: true }); } catch { console.log(`${f}: folder still in use, try again later`); }
      return;
    }
    case "close": { // close a ticket's runs (or one run: rig close 7); the slot frees for the next pane run
      if (/^\d+$/.test(pos[0] ?? "")) { const r = runOf(pos[0]); db.run("UPDATE runs SET status='closed' WHERE id=?", [r.id]); if (r.pane) shut(r.pane); }
      else closeRuns(ticket(pos[0]).id);
      return;
    }
    case "stop": {
      const r = runOf(pos[0]);
      // headless: the process dies, the run is stopped (tell resumes it). Pane: only the current turn stops; the agent
      // stays up and watched, so the run stays running
      if (r.mode === "headless") { if (r.pid) kill(r.pid); db.run("UPDATE runs SET status='stopped' WHERE id=?", [r.id]); }
      else mux.esc(r.pane);
      return;
    }
    case "say": { // to: manager | human | T-3 | T-3/reviewer
      const [to, ...rest] = pos;
      if (to === "human") {
        const tid = process.env.RIG_RUN ? me.split("/")[0] : null;
        db.run("INSERT INTO messages(ticket, frm, too, body, at) VALUES(?,?,?,?,?)", [tid, me, "human", rest.join(" "), now()]);
        mux.notify(`rig${tid ? " " + tid : ""}`, rest.join(" "));
        return;
      }
      const tid = process.env.RIG_RUN ? me.split("/")[0] : null;
      if (to === "orchestrator") { // the hub inbox; the orchestrator's `rig inbox --hub --wait` picks it up
        register(root);
        // ponytail: stored only, never typed into the orchestrator's pane; it is expected to keep its listener running
        openHub().run("INSERT INTO messages(repo, ticket, frm, too, body, at) VALUES(?,?,?,?,?,?)",
          [root, tid, `${repoName(root)}:${process.env.RIG_RUN ? me : "manager"}`, "orchestrator", rest.join(" "), now()]);
        return;
      }
      const target = to === "manager" ? ticket(tid ?? die("say manager only works inside a run")).manager
        : to.includes("/") ? to : `${ticket(to).id}/${lastRun(to)?.role ?? "worker"}`;
      deliver(to === "manager" ? tid : target.split("/")[0], target, rest.join(" "));
      return;
    }
    case "inbox": return readInbox(db, me, !!o.wait);
    case "ps": {
      const rows = db.query(`SELECT * FROM runs ${o.all ? "" : "WHERE status IN ('running','starting')"} ORDER BY id`).all() as any[];
      for (const r of rows) {
        const live = r.mode === "headless" ? "" : mux.status(r.pane);
        if (live === "gone" && r.status === "running") { db.run("UPDATE runs SET status='closed' WHERE id=?", [r.id]); r.status = "closed"; }
        console.log(`#${r.id}\t${r.ticket}\t${r.role}\t${r.harness}${r.model ? ":" + r.model : ""}\t${r.mode}${r.pane ? " " + r.pane : ""}\t${r.status}${live ? " / " + live : ""}`);
      }
      return;
    }
    case "board": {
      if (o.open || o.tab) return void openBoard(!!o.tab);
      if (o.json) return console.log(JSON.stringify(boardJson()));
      for (let first = true; ; first = false) {
        let text = board();
        // live board: never taller than the pane, or the header scrolls away. Cut from the bottom, say so.
        const rows = process.stdout.rows;
        if (!o.once && rows) {
          const lines = text.replace(/\n$/, "").split("\n");
          if (lines.length > rows - 1) text = lines.slice(0, rows - 2).join("\n") + "\n" + c(90, `   … ${lines.length - rows + 2} more lines (rig board --once | less)`) + "\n";
        }
        // redraw in place (home, clear each line's tail, clear below) so the board doesn't flicker
        process.stdout.write(o.once ? text : (first ? "\x1b[2J" : "") + "\x1b[H" + text.replace(/\n/g, "\x1b[K\n") + "\x1b[J");
        if (o.once) return;
        await Bun.sleep(120);
      }
    }
    default: die(`unknown command ${cmd}\n${HELP}`);
  }
}

// Where each harness looks for user-level skills. Installed as rig-<role>; harness dir must exist unless named explicitly.
export const SKILL_DIRS: Record<string, string> = {
  claude: ".claude/skills", codex: ".codex/skills", agents: ".agents/skills", opencode: ".config/opencode/skills",
  pi: ".pi/agent/skills", omp: ".omp/agent/skills", commandcode: ".commandcode/skills",
};
// a one-line notice when a newer release is out. GitHub is asked at most once a day (1.5s cap, quiet offline);
// the answer is cached in ~/.rig-update.json. RIG_NO_UPDATE_CHECK=1 turns it off; tests never check.
async function updateNotice() {
  if (process.env.RIG_NO_UPDATE_CHECK || process.env.NODE_ENV === "test") return;
  const file = join(process.env.RIG_HOME ?? homedir(), ".rig-update.json");
  let c: { at?: number, latest?: string } = {};
  try { c = JSON.parse(readFileSync(file, "utf8")); } catch {}
  if (!c.at || Date.now() - c.at > 86400000) {
    try {
      const r = await fetch("https://api.github.com/repos/zanuartri/herdr-rig/releases/latest", { signal: AbortSignal.timeout(1500) });
      if (r.ok) c.latest = String((await r.json()).tag_name ?? "").replace(/^v/, "");
    } catch {}
    c.at = Date.now();
    try { writeFileSync(file, JSON.stringify(c)); } catch {}
  }
  const mine = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")).version;
  const num = (v: string) => v.split(".").map(Number);
  const newer = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (c.latest && newer(num(c.latest), num(mine)) > 0)
    console.error(`rig ${c.latest} is out (you have ${mine}). Run: rig update`);
}

function install(names: string[]) {
  const home = process.env.RIG_HOME ?? homedir();
  // Claude Code reads user skills from $CLAUDE_CONFIG_DIR/skills when that is set (another account or profile)
  const claudeDir = process.env.CLAUDE_CONFIG_DIR;
  const root = (h: string, rel: string) => h === "claude" && claudeDir ? claudeDir : join(home, rel.split("/")[0]);
  const dir = (h: string, rel: string) => h === "claude" && claudeDir ? join(claudeDir, "skills") : join(home, rel);
  for (const [h, rel] of Object.entries(SKILL_DIRS)) {
    if (names.length ? !names.includes(h) : !existsSync(root(h, rel))) continue;
    for (const role of ["manager", "worker", "reviewer", "orchestrator"]) {
      const out = join(dir(h, rel), `rig-${role}`);
      mkdirSync(out, { recursive: true });
      // only the frontmatter (so the harness can find the skill) and a pointer: the instructions come from
      // `rig skill`, so they always match the installed rig and an update never needs another install
      const front = readFileSync(join(SKILLS, role, "SKILL.md"), "utf8").match(/^---\n[\s\S]*?\n---\n/)![0].replace(/^name: .*$/m, `name: rig-${role}`);
      writeFileSync(join(out, "SKILL.md"), `${front}\n# rig ${role}\n\nThe instructions ship with the rig CLI, so they always match the installed version. Run \`rig skill ${role}\` now and follow what it prints.\n`);
    }
    console.log(`${h}: ${dir(h, rel)}/rig-{manager,worker,reviewer,orchestrator}`);
  }
  // the Herdr desktop app gets the native board mod; herdr CLI users keep the terminal board
  const app = APP_HOME();
  if ((names.length ? names.includes("herdr-app") : existsSync(app))) {
    const out = join(app, "mods", "rig-board");
    mkdirSync(out, { recursive: true });
    for (const f of ["main.js", "mod.json", "rig.svg"]) writeFileSync(join(out, f), readFileSync(join(import.meta.dir, "mods", "rig-board", f)));
    console.log(`herdr-app: ${out}`);
  }
}
// same on Windows, macOS and Linux (the app reads ~/.config/herdr-app everywhere)
const APP_HOME = () => process.env.HERDR_APP_HOME ?? join(process.env.RIG_HOME ?? homedir(), ".config", "herdr-app");

const HELP = `rig: manager/worker/reviewer rig on herdr. State: <repo>/.rig/rig.db
  rig set <key> <value> | rig get [key]      keys: worker.harness worker.model reviewer.harness reviewer.model
                                             mode (pane|tab|headless) worktree (on|off|herdr) harness.<name> (JSON template)
  rig new "title" [--body text|-] [--review] [--after T-3,T-4] [--base br] [--story S-1]  create ticket (queued until those are done; base = your branch)
  rig ls [--mine] [--all] | rig show <T> | rig edit <T> status=done title=... story=... [--body -]
  rig dispatch <T> [note] [--role worker|reviewer] [--harness h] [--model m] [--effort e] [--mode pane|tab|headless] [--worktree on|off|herdr] [--no-worktree]
  rig tell <T|run#> <msg> [--now] [--role r]  steer the worker (or --role reviewer) (--now interrupts first; headless = interrupt + resume)
  rig stop <T|run#>                          interrupt
  rig say <manager|human|orchestrator|T|T/role> <msg>  message (pushed into the pane; human = herdr toast; orchestrator = hub inbox)
  rig board [--open|--tab] [--mine] [--all]  live ticket board (--open splits a pane, --tab opens a tab)
  rig clean [T] [--force]                     remove worktrees of done tickets (merged only, unless --force)
  rig close T-1|<run#>                       close a ticket's panes/tabs (status=done does it too)
  rig inbox [--wait]                         unread messages for me
  rig ps [--all]                             runs
orchestrator (any folder; repos registered in ~/.rig/hub.db by rig new / rig launch):
  rig launch <repo path> --brief <file> [--harness h] [--model m] [--effort e] [--mode tab|pane]  start that repo's manager
  rig inbox --hub [--wait]                   ticket events (needs-you/blocked/review) and rig say orchestrator messages
  rig tell <repo>:manager <msg>              message a repo's manager (repo name or path)
  rig board --hub [--all] [--once] [--open|--tab] [--json]  every registered repo, by story then repo (--open: the app board beside you)
  rig update                                 update rig (and the board mod); installed skills follow by themselves
  rig install [claude codex agents opencode pi omp commandcode herdr-app]
                                             skills as rig-manager/worker/reviewer/orchestrator + the herdr-app board mod (default: all found)
  rig skill [manager|worker|reviewer|orchestrator]  print a skill (for harnesses without skill support)
harnesses: ${Object.keys(HARNESSES).join(", ")}`;

if (import.meta.main) await main(process.argv.slice(2));
