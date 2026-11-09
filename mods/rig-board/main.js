// rig board for the Herdr app: tickets grouped by what they need from you. Data comes from `rig board --json`;
// live agent status and icons come from Herdr itself (terminals()), so those update without polling.
// props: { rig: "<path to rig.ts>", root: "<repo>" }. Opened by `rig board --open` as a pane beside the manager.
// Look: neutral and dense. The only color is the small status mark.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, run, theme, props, notify, terminals } from "herdr";

// brand: the rig tower in "rig amber", the one color that is ours rather than the theme
const BRAND = "#f5a524";
const LOGO = "mods/rig-board/rig.svg";
// each harness keeps its own color on the board, so who is working reads at a glance
const HUE = { claude: "#e08a63", codex: "#3fb489", opencode: "#6f93ff", pi: "#a98bfa", omp: "#f07ab6", commandcode: "#34c6dc" };
const EFFORT = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// what you watch comes first: Working is never pushed off screen by a long Ready list
const ORDER = ["Needs you", "Working", "Ready", "Queued", "To do", "Done"];
const LIMIT = { "Needs you": 3, Working: Infinity, Ready: 3, Queued: 3, "To do": 5, Done: 5 };
const KEY = { "Needs you": "blocked", Ready: "done", Working: "working", Queued: "queued", "To do": "idle", Done: "dim" };

function ago(at) {
  if (!at) return "";
  const m = Math.round((Date.now() - Date.parse(at.replace(" ", "T") + "Z")) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
// theme colors may already carry alpha (#rrggbbaa): keep #rrggbb, then add ours
const alpha = (c, a) => (c ?? "#888888").slice(0, 7) + a;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const short = (model) => (model ?? "").split("/").pop();

export default class RigBoard extends View {
  init(_props, cx) {
    this.data = null;
    this.width = 400;
    this.error = "";
    this.folded = new Set(["To do", "Done"]);
    this.expanded = new Set();
    this.seen = new Set(JSON.parse(localStorage.getItem("seen") ?? "[]")); // needs-you tickets already notified
    cx.timer.every(2000, (cx) => this.refresh(cx));
    cx.timer.every(30000, (cx) => cx.notify()); // ages
    this.refresh(cx);
  }

  refresh(cx) {
    const p = props() ?? {};
    cx.spawn(async (cx) => {
      try {
        const r = await exec("bun", [p.rig, "board", "--json", "--hc"], { cwd: p.root });
        if (r.code) throw new Error(r.stderr.trim() || `rig exited ${r.code}`);
        if (r.stdout === this.raw && !this.error) return; // nothing changed: skip the redraw
        this.raw = r.stdout;
        this.data = JSON.parse(r.stdout);
        this.error = "";
        this.alert(this.data);
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      cx.notify();
    });
  }

  // a toast the first time a ticket needs you; clicking it goes to the manager
  alert(data) {
    for (const x of data.groups.find((g) => g.title === "Needs you")?.tickets ?? []) {
      const key = `${x.id}:${x.noteAt}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const manager = this.manager(x);
      notify({ title: `${x.id} needs you`, body: x.note || x.title, level: "warning",
        ...(manager ? { action: { name: "pane.focus", args: { terminal: manager } } } : {}) });
    }
    localStorage.setItem("seen", JSON.stringify([...this.seen].slice(-200)));
  }

  manager(x) { return x.manager?.startsWith("manager:") ? x.manager.slice(8) : null; }

  mark(t, key) {
    if (key === "working") return div().text_size(14).font_bold().text_color(t.working).frames(SPIN, 80);
    if (key === "idle") return div().size(8).rounded_full().border(1.5).border_color(t.muted);
    if (key === "dim") return svg(ICON("check")).size(11).text_color(t.dim);
    return div().size(8).rounded_full().bg(t[key]);
  }

  chip(t, text, color = t.muted) {
    return div().flex_none().px(6).h(18).rounded(5).bg(t.raised).flex().items_center()
      .text_size(11).font_semibold().text_color(color).child(text);
  }

  // a tinted pill: soft background and text in one hue
  tint(hue, children) {
    return h_flex().flex_none().gap(4).px(7).h(18).rounded(9).items_center().bg(alpha(hue, "24"))
      .text_size(11).font_semibold().text_color(hue).children(children);
  }

  // effort as four small bars, lit up to its level
  meter(t, effort) {
    const lit = EFFORT[effort] ?? 2;
    return h_flex().flex_none().gap(4).items_center()
      .child(h_flex().gap(2).items_end().children([1, 2, 3, 4].map((i) =>
        div().w(3).h(4 + i * 2).rounded(1).bg(i <= lit ? t.working : t.raised))))
      .child(div().text_size(11).text_color(t.muted).child(effort));
  }

  // right column. Top: the one button that moves focus (Answer, Review, Open), else the age.
  // Bottom: who is on it (role, harness with icon, model, effort), else the age.
  // Only the button changes focus; clicking the card itself does nothing, so the board never yanks you away.
  side(t, key, x, glyph, c, goto, stuck) {
    const label = !goto ? null : key === "blocked" ? (x.status === "blocked" ? "Unblock" : "Answer") : key === "done" ? "Review" : "Open";
    const age = div().h(18).flex().items_center().text_size(11).text_color(t.dim).child(ago(x.run?.started ?? x.noteAt) || " ");
    const strong = key === "blocked" || key === "done";
    const button = label && h_flex().id(`go-${x.id}`).h(18).px(7).gap(3).rounded(5).items_center().cursor_pointer()
      .bg(strong ? alpha(c, "2e") : t.raised).hover((h) => h.bg(strong ? alpha(c, "48") : t.hover))
      .text_size(11).font_semibold().text_color(strong ? c : t.foreground)
      .on_click(() => run("pane.focus", { terminal: goto }))
      .child(label).child(svg(ICON("chevron-right")).size(10).text_color(strong ? c : t.muted));
    // queued: the tickets it waits on, with their state
    const deps = key === "queued" && (x.waiting ?? []).length && h_flex().gap(4).items_center()
      .child(div().text_size(11).text_color(t.dim).child("after"))
      .children(x.waiting.map((w) => this.chip(t, w.replace(" (", " · ").replace(")", ""))));
    const hue = HUE[x.run?.harness] ?? t.accent;
    const crew = x.run && h_flex().gap(6).items_center()
      .when(!!stuck && key === "working", (el) => el.child(this.tint(t.blocked, [div().child(stuck)])))
      .child(this.tint(x.run.role === "reviewer" ? t.ready ?? t.done : BRAND, [div().child(x.run.role)]))
      .child(this.tint(hue, [glyph, div().child(x.run.harness)].filter(Boolean)))
      .when(!!x.run.model, (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(short(x.run.model))))
      .when(!!x.run.effort, (el) => el.child(this.meter(t, x.run.effort)))
      .when(x.run.mode === "headless", (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("headless")));
    return v_flex().flex_none().items_end().gap(3)
      .child(button ? h_flex().gap(6).items_center().child(age).child(button) : age)
      .when(!!crew, (el) => el.child(crew))
      .when(!crew && !!deps, (el) => el.child(deps))
      .when(!crew && !!stuck && key === "working", (el) => el.child(this.tint(t.blocked, [div().child("worker exited")])))
  }

  // how the manager is set to work. Changing these is the manager's job (rig set), so this only shows them.
  settings(t, st) {
    const AUTONOMY = { ask: "asks after each ticket", review: "merges on your yes", merge: "auto-merges" };
    const item = (icon, label, value, hot) => h_flex().flex_none().gap(5).items_center()
      .child(svg(ICON(icon)).size(11).text_color(hot ? BRAND : t.dim))
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(div().text_size(11).font_semibold().text_color(hot ? BRAND : t.muted).child(value));
    return h_flex().px(12).h(28).flex_none().gap(14).items_center().overflow_hidden().border_b(1).border_color(t.border)
      .child(item("circle-check", "merge", `${AUTONOMY[st.autonomy] ?? st.autonomy} · ${st.merge === "pr" ? "via PR" : "local"}`, st.autonomy === "merge"))
      .child(item("git-branch", "worktree", st.worktree, false))
      .child(item("terminal", "runs in", st.mode, false))
      .when(!!st.worker, (el) => el.child(item("square-pen", "worker", st.worker, false)))
      .when(!!st.reviewer, (el) => el.child(item("search", "reviewer", st.reviewer, false)));
  }

  row(t, g, x) {
    const key = KEY[g.title];
    const done = key === "dim";
    const term = x.run?.pane ? terminals().find((y) => y.address === x.run.pane) : null;
    // where the button goes: a live worker's pane, or the manager for something waiting on you
    const goto = term ? x.run.pane : key === "blocked" || key === "done" ? this.manager(x) : null;
    const p = term?.program;
    const glyph = p?.icon ? (p.tint ? svg(p.icon).size(11).text_color(HUE[x.run?.harness] ?? t.foreground) : image(p.icon).w(11).h(11)) : null;
    const accent = key === "blocked" || key === "working";
    // stuck: the ticket says blocked, or a running agent is blocked on a dialog or hit an error
    const liveState = term?.status ?? x.run?.live;
    const stuck = x.status === "blocked" ? "blocked" : key === "working" && x.orphan ? "exited" : key === "working" && (liveState === "blocked" || liveState === "error") ? liveState : null;
    const title = h_flex().gap(7).items_center().h(18)
      .when(done, (el) => el.child(h_flex().w(14).flex_none().justify_center().child(this.mark(t, key))))
      .child(div().flex_none().text_size(11.5).font_semibold().text_color(done ? t.dim : t.muted).child(x.id))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(done ? t.dim : t.foreground)
        .when(!done, (d) => d.font_semibold()).child(x.title))
;
    if (done) return h_flex().id(`t-${x.id}`).flex_none().px(8).py(3).rounded(5).hover((h) => h.bg(t.hover)).child(title.flex_1());
    // left line 2: what the agent is doing, or the last message
    const branch = x.branch && h_flex().flex_none().gap(4).items_center()
      .child(svg(ICON("git-branch")).size(11).text_color(t.dim))
      .child(div().text_size(11.5).text_color(t.dim).child(x.branch));
    const line2 = (!!x.note || !!branch) && h_flex().h(18).min_w(0).gap(8).items_center().overflow_hidden()
      .when(!!branch, (el) => el.child(branch))
      .when(!!x.note, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12)
        .text_color(key === "blocked" ? t.foreground : t.muted)
        .when(key === "working", (d) => d.loop("opacity", { from: 0.55, to: 1, period: 2400 }))
        .child(key === "working" ? `› ${x.note}` : x.note)));
    // status tile: a soft square in the status color holding the mark, as tall as the card's text
    const c = stuck ? t.blocked : t[key] ?? t.dim;
    const big = 34;
    const icon = stuck ? div().text_size(17).font_bold().text_color(t.blocked).child("!")
      : key === "queued" ? svg(ICON("clock")).size(15).text_color(t.muted)
      : key === "working" ? div().text_size(17).font_bold().text_color(c).frames(SPIN, 80)
      : key === "blocked" ? div().text_size(16).font_bold().text_color(c).child("?")
      : key === "done" ? svg(ICON("circle-check")).size(16).text_color(c)
      : div().size(11).rounded_full().border(2).border_color(t.muted);
    const tile = h_flex().flex_none().size(big).rounded(8).justify_center().items_center()
      .bg(key === "idle" || (key === "queued" && !stuck) ? t.raised : alpha(c, "26"))
      .when(key === "blocked" || !!stuck, (el) => el.loop("opacity", { from: 0.7, to: 1, period: 1600 }))
      .child(icon);
    return h_flex().id(`t-${x.id}`).flex_none().min_w(0).gap(10).items_center().pl(7).pr(10).py(7).rounded(10)
      .bg(t.raised ? alpha(t.raised, "aa") : t.background).border(1).border_color(t.border)
      .hover((h) => h.bg(t.hover).border_color(t.input))
      .child(tile)
      .child(v_flex().flex_1().min_w(0).gap(2).child(title).when(!!line2, (el) => el.child(line2)))
      .child(this.side(t, key, x, glyph, c, goto, stuck));
  }

  group(t, g) {
    const folded = this.folded.has(g.title);
    const open = this.expanded.has(g.title);
    const rows = open ? g.tickets : g.tickets.slice(0, LIMIT[g.title]);
    const hidden = g.tickets.length - rows.length;
    return v_flex().flex_none().gap(g.title === "Done" ? 0 : 5)
      // group header: status dot, plain label, the count as a quiet number, a hairline to the chevron
      .child(h_flex().id(`g-${g.title}`).px(6).h(28).gap(8).items_center().cursor_pointer()
        .hover((h) => h.text_color(t.foreground))
        .on_click((_e, cx) => { folded ? this.folded.delete(g.title) : this.folded.add(g.title); cx.notify(); })
        .child(div().size(6).rounded_full().flex_none().bg(KEY[g.title] === "idle" || KEY[g.title] === "dim" || KEY[g.title] === "queued" ? t.dim : t[KEY[g.title]]))
        .child(div().flex_none().text_size(12.5).font_semibold().text_color(folded ? t.muted : t.foreground).child(g.title))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(String(g.count ?? g.tickets.length)))
        .child(div().flex_1())
        .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim)))
      .when(!folded, (el) => el
        .children(rows.map((x) => this.row(t, g, x)))
        .when(hidden > 0 || (open && g.tickets.length > LIMIT[g.title]), (el) => el.child(
          div().id(`more-${g.title}`).pl(62).h(20).flex().items_center().cursor_pointer()
            .text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { open ? this.expanded.delete(g.title) : this.expanded.add(g.title); cx.notify(); })
            .child(hidden > 0 ? `${hidden} more` : "less")))
        // older Done tickets never reach the board; say how many and where to see them
        .when((g.count ?? 0) > g.tickets.length, (el) => el.child(
          div().pl(62).h(20).flex().items_center().text_size(11).text_color(t.dim)
            .child(`${g.count - g.tickets.length} older · rig ls --all`))));
  }

  render(cx) {
    const t = theme();
    const groups = ORDER.map((n) => this.data?.groups.find((g) => g.title === n)).filter((g) => g?.tickets.length);
    const live = new Map(terminals().map((y) => [y.address, y]));
    const working = groups.find((g) => g.title === "Working")?.tickets ?? [];
    const running = working.map((x) => live.get(x.run?.pane)?.program).filter((p) => p?.icon && p.agent);
    const needs = groups.find((g) => g.title === "Needs you")?.tickets.length ?? 0;
    const stats = groups.filter((g) => g.title !== "Done" && g.title !== "Needs you" && g.title !== "Working")
      .map((g) => [g.tickets.length, g.title.toLowerCase()]);
    return v_flex().id("root").size_full()
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 4) { this.width = size.width; cx.notify(); } }).bg(t.surface).text_color(t.foreground)
      // header: brand + repo, then the counts as number-and-word pairs, then what wants attention as pills
      .child(h_flex().px(12).h(42).flex_none().gap(10).items_center().border_b(1).border_color(t.border)
        .child(h_flex().flex_none().gap(7).items_center()
          .child(h_flex().size(24).rounded(7).bg(alpha(BRAND, "26")).justify_center().items_center()
            .child(svg(LOGO).size(14).text_color(BRAND)))
          .child(div().text_size(14).font_bold().text_color(BRAND).child("rig"))
          .child(div().text_size(13).text_color(t.dim).child("/"))
          .child(div().text_size(13.5).font_bold().text_color(t.foreground).child(this.data?.repo ?? "")))
        .child(h_flex().flex_1().min_w(0).gap(12).items_center().overflow_hidden().pl(4)
          .children(stats.map(([n, label]) => h_flex().flex_none().gap(4).items_baseline()
            .child(div().text_size(12.5).font_bold().text_color(t.foreground).child(String(n)))
            .child(div().text_size(11.5).text_color(t.dim).child(label)))))
        .when(working.length > 0, (el) => el.child(this.tint(t.working, [
          div().size(6).rounded_full().bg(t.working).loop("opacity", { from: 0.25, to: 1, period: 1600 }),
          ...running.slice(0, 3).map((p) => p.tint ? svg(p.icon).size(11).text_color(t.working) : image(p.icon).w(11).h(11)),
          div().child(`${working.length} running`)])))
        .when(needs > 0, (el) => el.child(this.tint(t.blocked, [
          div().size(6).rounded_full().bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1400 }),
          div().child(`${needs} needs you`)]))))
      .when(!!this.data?.settings, (el) => el.child(this.settings(t, this.data.settings)))
      .when(!!this.error, (el) => el.child(div().mx(8).mt(8).px(8).py(6).rounded(5).border(1).border_color(t.border)
        .text_size(11).text_color(t.muted).child(this.error)))
      .child(v_flex().id("list").flex_1().overflow_y_scrollbar().px(8).py(6).gap(8)
        .children(groups.map((g) => this.group(t, g)))
        .when(!!this.data && !groups.length, (el) => el.child(v_flex().py(40).gap(8).items_center()
          .child(svg(LOGO).size(28).text_color(alpha(BRAND, "aa")))
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child("The rig is quiet"))
          .child(div().text_size(12).text_color(t.dim).child("Tell the manager what needs doing.")))));
  }
}
