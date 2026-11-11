import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { argv, HARNESSES, slot, worktreePlan, deep, openHub, launchCmd } from "./rig.ts";

// every temp repo and home a test makes goes when the run ends
const made: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterAll(() => { for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch {} });

// rig runs export RIG_ROOT, so `bun test` inside a worker inherits it; the CLI calls below must not follow it.
// A decoy RIG_ROOT proves that: the last test checks that nothing was written there.
const decoy = tmp("rig-decoy-");
process.env.RIG_ROOT = decoy;
// `rig new` registers each repo in the hub (<RIG_HOME>/.rig/hub.db); keep it out of the real home
const hubHome = tmp("rig-hubhome-");
process.env.RIG_HOME = hubHome;
const mkrepo = () => {
  const repo = tmp("rig-");
  Bun.spawnSync(["git", "init", "-q", repo]);
  Bun.spawnSync(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
};
const rigIn = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "rig.ts"), ...args],
    { cwd, env: { ...process.env, HERDR_PANE_ID: "", HC_TERMINAL_ID: "", RIG_RUN: "", RIG_ROOT: "", ...env } });
  return p.stdout.toString().trim() + p.stderr.toString().trim();
};

test("argv expands model and sid, drops model when unset", () => {
  expect(argv(HARNESSES.claude, "headless", "opus", "S", "go")).toEqual(
    ["claude", "-p", "--dangerously-skip-permissions", "--session-id", "S", "--model", "opus", "go"]);
  expect(argv(HARNESSES.omp, "interactive", "", "S")).toEqual(["omp"]);
});

test("ticket, messages and a headless run end to end", async () => {
  const repo = tmp("rig-");
  Bun.spawnSync(["git", "init", "-q", repo]);
  Bun.spawnSync(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  const rig = (args: string[], env: Record<string, string> = {}, stdin?: string) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "rig.ts"), ...args],
      { cwd: repo, env: { ...process.env, HERDR_PANE_ID: "", HC_TERMINAL_ID: "", RIG_RUN: "", RIG_ROOT: "", ...env }, stdin: stdin ? new Blob([stdin]) : "ignore" });
    return p.stdout.toString().trim() + p.stderr.toString().trim();
  };
  expect(rig(["new", "Add", "thing", "--body", "-"], {}, "Goal: x")).toBe("T-1");
  expect(rig(["show", "T-1"])).toContain("Goal: x");
  rig(["set", "harness.fake", JSON.stringify({ model: [], headless: ["bun", "-e", "console.log('worked')"] })]);
  expect(rig(["dispatch", "T-1", "--harness", "fake", "--mode", "headless"])).toBe("run #1 headless");
  let inbox = "";
  for (let i = 0; i < 40 && !inbox.includes("worked"); i++) { await Bun.sleep(250); inbox = rig(["inbox"]); }
  expect(inbox).toContain("exited (0)");
  expect(rig(["show", "T-1"])).toContain("worktree:");
  rig(["say", "manager", "Q: A or B?"], { RIG_RUN: "1" });
  expect(rig(["inbox"])).toContain("T-1/worker [T-1]: Q: A or B?");
  rig(["say", "T-1", "go A"]);
  expect(rig(["inbox"], { RIG_RUN: "1" })).toContain("go A");
  rig(["new", "Second"]);
  rig(["edit", "T-2", "status=needs-you"]);
  const board = rig(["board", "--once"]);
  expect(board.indexOf("NEEDS YOU")).toBeLessThan(board.indexOf("WORKING"));
  expect(board).toContain("go A");
}, 30000);

test("base branch, squash landing, --after and cleanup", async () => {
  const repo = tmp("rig-");
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a]).stdout.toString().trim();
  git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "init"); git("switch", "-q", "-c", "feat");
  const rig = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "rig.ts"), ...args],
      { cwd: repo, env: { ...process.env, HERDR_PANE_ID: "", HC_TERMINAL_ID: "", RIG_RUN: "", RIG_ROOT: "" } });
    return p.stdout.toString().trim() + p.stderr.toString().trim();
  };
  expect(rig("new")).toContain("usage"); // no title, no ticket
  expect(rig("new", "a")).toBe("T-1");
  expect(rig("new", "b", "--after", "T-1", "--base", "main")).toBe("T-2");
  expect(rig("new", "c", "--after", "T-1 T-2")).toBe("T-3"); // space-separated list
  expect(rig("board", "--json")).toContain('"waiting":["T-1 (open)","T-2 (open)"]');
  // the worker commits a file on its branch
  rig("set", "harness.fake", JSON.stringify({ model: [], headless: ["bun", "-e",
    "require('fs').writeFileSync('f','x'); for (const a of [['add','f'],['commit','-qm','f']]) Bun.spawnSync(['git',...a])"] }));
  rig("dispatch", "T-1", "--harness", "fake", "--mode", "headless");
  for (let i = 0; i < 40 && !rig("inbox").includes("exited"); i++) await Bun.sleep(250);
  expect(rig("show", "T-1")).toContain("branch rig/T-1 from feat");
  const done = rig("edit", "T-1", "status=done");
  expect(done).toContain("not merged, worktree kept"); // unmerged work stays
  expect(done).toContain("T-2 is unblocked"); // to its own manager: printed, not queued
  git("merge", "--squash", "-q", "rig/T-1"); git("commit", "-qm", "T-1");
  expect(rig("clean", "T-1")).toContain("worktree and branch removed"); // squash merge counts as landed
  expect(git("branch", "--list", "rig/T-1")).toBe("");
  // a leftover folder under .rig/wt that is no longer a worktree gets swept
  mkdirSync(join(repo, ".rig", "wt", "T-9"), { recursive: true });
  rig("clean");
  expect(require("node:fs").existsSync(join(repo, ".rig", "wt", "T-9"))).toBe(false);
}, 30000);

test("install copies renamed skills only into harnesses that exist", () => {
  const home = tmp("rig-home-");
  for (const d of [".codex", ".config"]) mkdirSync(join(home, d), { recursive: true });
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "rig.ts"), "install"], { env: { ...process.env, RIG_HOME: home, CLAUDE_CONFIG_DIR: "" } });
  const out = p.stdout.toString();
  expect(out).toContain("codex:");
  expect(out).toContain("opencode:");
  expect(out).not.toContain("claude:");
  const skill = require("node:fs").readFileSync(join(home, ".codex/skills/rig-worker/SKILL.md"), "utf8");
  expect(skill).toContain("name: rig-worker");
  expect(skill).toContain("rig skill worker"); // a pointer, so an update needs no reinstall
  expect(require("node:fs").readFileSync(join(home, ".codex/skills/rig-orchestrator/SKILL.md"), "utf8")).toContain("rig skill orchestrator");
});

test("install puts Claude skills under CLAUDE_CONFIG_DIR when it is set", () => {
  const home = tmp("rig-home-");
  const profile = tmp("rig-claude-profile-");
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "rig.ts"), "install"],
    { env: { ...process.env, RIG_HOME: home, CLAUDE_CONFIG_DIR: profile } });
  expect(p.stdout.toString()).toContain(`claude: ${join(profile, "skills")}/rig-`);
  expect(require("node:fs").readFileSync(join(profile, "skills/rig-manager/SKILL.md"), "utf8")).toContain("name: rig-manager");
  expect(require("node:fs").existsSync(join(home, ".claude"))).toBe(false);
});

test("a newer inbox listener takes over: the older one exits and the message reaches the newer one", async () => {
  const repo = tmp("rig-");
  Bun.spawnSync(["git", "init", "-q", repo]);
  Bun.spawnSync(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  const env = { ...process.env, HERDR_PANE_ID: "", HC_TERMINAL_ID: "", RIG_RUN: "", RIG_ROOT: "" };
  const cli = (...args: string[]) => ["bun", join(import.meta.dir, "rig.ts"), ...args];
  const rig = (...args: string[]) => {
    const p = Bun.spawnSync(cli(...args), { cwd: repo, env });
    return p.stdout.toString().trim() + p.stderr.toString().trim();
  };
  rig("new", "a");
  rig("set", "harness.fake", JSON.stringify({ model: [], headless: ["bun", "-e", "console.log('worked')"] }));
  const older = Bun.spawn(cli("inbox", "--wait"), { cwd: repo, env, stdout: "pipe" });
  await Bun.sleep(1000);
  const newer = Bun.spawn(cli("inbox", "--wait"), { cwd: repo, env, stdout: "pipe" });
  await older.exited; // within one poll (2 s) of the newer listener registering
  expect(await new Response(older.stdout).text()).toContain("replaced by a newer listener");
  rig("dispatch", "T-1", "--harness", "fake", "--mode", "headless");
  await newer.exited;
  expect(await new Response(newer.stdout).text()).toContain("exited (0)");
}, 30000);

test("the board shows the running worker, not a reviewer that already closed", () => {
  const repo = tmp("rig-");
  Bun.spawnSync(["git", "init", "-q", repo]);
  Bun.spawnSync(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  const env = { ...process.env, HERDR_PANE_ID: "", HC_TERMINAL_ID: "", RIG_RUN: "", RIG_ROOT: "" };
  const rig = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "rig.ts"), ...args], { cwd: repo, env }).stdout.toString();
  rig("new", "fix after review");
  rig("set", "harness.slow", JSON.stringify({ model: [], headless: ["bun", "-e", "setTimeout(() => {}, 20000)"] }));
  rig("dispatch", "T-1", "--harness", "slow", "--mode", "headless", "--no-worktree");        // run 1: worker, still going
  rig("dispatch", "T-1", "--role", "reviewer", "--harness", "slow", "--mode", "headless");   // run 2: reviewer
  rig("close", "2");                                                                          // FIX sent, reviewer closed
  rig("edit", "T-1", "status=working");
  const json = JSON.parse(rig("board", "--json"));
  const t = json.groups.find((g: any) => g.title === "Working").tickets[0];
  expect(t.run.role).toBe("worker");
  expect(t.orphan).toBe(false);
  // `tell T-1` steers the worker even though the reviewer is the newer run
  rig("tell", "T-1", "fix it");
  expect(Bun.spawnSync(["bun", join(import.meta.dir, "rig.ts"), "inbox"], { cwd: repo, env: { ...env, RIG_RUN: "1" } }).stdout.toString()).toContain("fix it");
  rig("close", "T-1");
}, 30000);

test("rig new registers the repo in the hub and keeps its story", () => {
  const repo = mkrepo();
  expect(rigIn(repo, ["new", "a", "--story", "S-1"])).toBe("T-1");
  rigIn(repo, ["new", "b"]);
  expect(rigIn(repo, ["show", "T-1"])).toContain("story: S-1");
  rigIn(repo, ["edit", "T-2", "story=S-2"]);
  expect(rigIn(repo, ["show", "T-2"])).toContain("story: S-2");
  const rows = openHub().query("SELECT * FROM repos WHERE name=?").all(basename(repo)) as any[];
  expect(rows.length).toBe(1); // idempotent across rig new calls
});

test("hub: status events and say orchestrator reach the hub inbox; tell <repo>:manager reaches the manager", async () => {
  const a = mkrepo(), b = mkrepo(), out = tmp("rig-out-"); // the orchestrator runs from a folder that is not a repo
  rigIn(a, ["new", "x"]); rigIn(b, ["new", "y"]);
  rigIn(out, ["inbox", "--hub"]); // drain what other tests left in the shared hub
  const quiet = mkrepo(), qn = basename(quiet);
  rigIn(quiet, ["new", "q"]);
  if (!openHub().query("SELECT 1 FROM settings WHERE k='listener.orchestrator'").get()) { // no orchestrator yet: no events
    rigIn(quiet, ["edit", "T-1", "status=review"]);
    expect(openHub().query("SELECT 1 FROM messages WHERE frm=?").get(`${qn}:T-1`)).toBeNull();
  }
  const listener = Bun.spawn(["bun", join(import.meta.dir, "rig.ts"), "inbox", "--hub", "--wait"],
    { cwd: out, env: { ...process.env, HERDR_PANE_ID: "", HC_TERMINAL_ID: "", RIG_ROOT: "" }, stdout: "pipe" });
  await Bun.sleep(500);
  rigIn(b, ["edit", "T-1", "status=needs-you"]);
  await listener.exited;
  expect(await new Response(listener.stdout).text()).toContain(`${basename(b)}:T-1 [T-1]: T-1 is needs-you: y`);
  rigIn(a, ["edit", "T-1", "status=working"]); // not an event
  rigIn(a, ["say", "orchestrator", "Q: ship A first?"]);
  const inbox = rigIn(out, ["inbox", "--hub"]);
  expect(inbox).toContain(`${basename(a)}:manager: Q: ship A first?`);
  expect(inbox).not.toContain("working");
  expect(rigIn(out, ["tell", `${basename(a)}:manager`, "go"])).toContain("no manager yet");
  openHub().run("UPDATE repos SET manager='local' WHERE name=?", [basename(a)]);
  rigIn(out, ["tell", `${basename(a)}:manager`, "yes, A first"]);
  expect(rigIn(a, ["inbox"])).toContain("orchestrator: yes, A first");
}, 30000);

test("board --hub shows every registered repo, by story then repo", () => {
  const a = mkrepo(), b = mkrepo(), out = tmp("rig-out-");
  const [na, nb] = [a, b].map(r => basename(r));
  rigIn(a, ["new", "api change", "--story", "S-HUB"]);
  rigIn(b, ["new", "client change", "--story", "S-HUB"]);
  rigIn(b, ["new", "loose end"]);
  rigIn(b, ["edit", "T-1", "status=needs-you"]);
  rigIn(a, ["new", "finished", "--story", "S-HUB"]); rigIn(a, ["edit", "T-2", "status=done"]);
  const board = rigIn(out, ["board", "--hub", "--once"]);
  const story = board.indexOf("STORY S-HUB"), none = board.indexOf("NO STORY");
  expect(story).toBeGreaterThan(-1);
  expect(board.indexOf("api change")).toBeGreaterThan(story);
  expect(board.indexOf("client change")).toBeGreaterThan(story);
  expect(board.indexOf("client change")).toBeLessThan(none);
  expect(board.indexOf("loose end")).toBeGreaterThan(none);
  expect(board.slice(story, none)).toContain(na);
  expect(board.slice(story, none)).toContain(nb);
  expect(board).toContain("needs-you");
  expect(board).not.toContain("finished");
  expect(rigIn(out, ["board", "--hub", "--once", "--all"])).toContain("finished");
  // the app board's data: each repo's own cards, regrouped by story
  const json = JSON.parse(rigIn(out, ["board", "--hub", "--json"]));
  const s = json.stories.find((x: any) => x.story === "S-HUB");
  expect(s.repos.map((r: any) => r.name).sort()).toEqual([na, nb].sort());
  expect(s.repos.find((r: any) => r.name === nb).groups.find((g: any) => g.title === "Needs you").tickets[0].title).toBe("client change");
  expect(json.stories.at(-1).story).toBeNull(); // no story goes last
  expect(JSON.stringify(json.stories.at(-1))).toContain("loose end");
}, 30000);

test("launch: the manager starts on its skill and brief; bad input stops before any pane opens", () => {
  const { prompt, cmd } = launchCmd(HARNESSES.claude, "/b/brief.md", "opus", "", "S");
  expect(cmd).toEqual(["claude", "--dangerously-skip-permissions", "--session-id", "S", "--model", "opus", prompt]);
  expect(prompt).toContain("rig skill manager");
  expect(prompt).toContain("/b/brief.md");
  expect(prompt).toContain("rig say orchestrator");
  expect(launchCmd(HARNESSES.commandcode, "/b.md", "", "", "S").cmd).not.toContain(prompt); // typed in after start instead
  const out = tmp("rig-out-"), repo = mkrepo();
  expect(rigIn(out, ["launch", out, "--brief", "x"])).toContain("is not a git repo");
  expect(rigIn(out, ["launch", join(out, "gone"), "--brief", "x"])).toContain("no folder");
  expect(rigIn(out, ["launch", repo])).toContain("--brief <file> is required");
  expect(rigIn(out, ["launch", repo, "--brief", "nope.md"])).toContain("no brief at");
});

test("no test followed the inherited RIG_ROOT", () => {
  expect(require("node:fs").existsSync(join(decoy, ".rig"))).toBe(false);
});

test("slot: overflow tab fills the left column (4 even rows), then one pane beside each row, then a new tab", () => {
  const p = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  expect(slot([])).toEqual({ place: "tab" });
  expect(slot(p(1))).toEqual({ place: "down", anchor: "p0" });
  expect(slot(p(2))).toEqual({ place: "down", anchor: "p0" });
  expect(slot(p(3))).toEqual({ place: "down", anchor: "p1" });
  expect(slot(p(4))).toEqual({ place: "right", anchor: "p0" });
  expect(slot(p(7))).toEqual({ place: "right", anchor: "p3" });
  expect(slot(p(8))).toEqual({ place: "tab" });
});

test("worktreePlan: on/off unchanged, herdr puts a worker's worktree in its own space", () => {
  const p = worktreePlan;
  expect(p("worker", "on", false, "pane", false, false)).toEqual({ space: false, git: true });
  expect(p("worker", "off", false, "pane", false, false)).toEqual({ space: false, git: false });
  expect(p("worker", "herdr", true, "pane", false, false)).toEqual({ space: false, git: false }); // --no-worktree
  expect(p("worker", "herdr", false, "pane", false, false)).toEqual({ space: true, git: false });
  expect(p("worker", "herdr", false, "headless", false, false)).toEqual({ space: false, git: true }); // no pane to put in a space
  expect(p("reviewer", "herdr", false, "pane", true, true)).toEqual({ space: true, git: false }); // beside the live worker
  expect(p("reviewer", "on", false, "pane", true, true).space).toBe(true); // a ticket already in a space keeps its reviewer there
  expect(p("reviewer", "herdr", false, "pane", false, false)).toEqual({ space: false, git: false }); // nothing to review in
});

test("deep finds ids in nested herdr replies", () => {
  expect(deep({ result: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "p1" } } }, "workspace_id")).toBe("w1");
  expect(deep({ result: {} }, "pane_id")).toBeUndefined();
});
