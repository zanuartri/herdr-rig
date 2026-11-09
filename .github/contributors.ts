// Draws the repo's human contributors as one SVG of avatars (contributors.svg). Bots and AI agents are left out:
// GitHub's Bot accounts, and logins that name an agent. Run by .github/workflows/contributors.yml.
const repo = process.env.GITHUB_REPOSITORY ?? "zanuartri/herdr-rig";
const headers = { accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
const AGENT = /\[bot\]|bot$|claude|anthropic|copilot|codex|openai|devin|cursor|gemini|dependabot|renovate|github-actions/i;

const all = await (await fetch(`https://api.github.com/repos/${repo}/contributors?per_page=100`, { headers })).json() as any[];
const people = all.filter(c => c.type === "User" && !AGENT.test(c.login));

const size = 64, gap = 12, cols = 12;
const cells = await Promise.all(people.map(async (p, i) => {
  const r = await fetch(`${p.avatar_url}&s=${size * 2}`);
  const type = r.headers.get("content-type") ?? "image/png"; // avatars come as png or jpeg
  const img = Buffer.from(await r.arrayBuffer()).toString("base64");
  const x = (i % cols) * (size + gap), y = Math.floor(i / cols) * (size + gap);
  return `<a href="https://github.com/${p.login}"><title>${p.login}</title>`
    + `<clipPath id="c${i}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath>`
    + `<image x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#c${i})" href="data:${type};base64,${img}"/></a>`;
}));
const w = Math.min(people.length, cols) * (size + gap) - gap, h = Math.ceil(people.length / cols) * (size + gap) - gap;
await Bun.write("contributors.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(w, 1)}" height="${Math.max(h, 1)}">${cells.join("")}</svg>\n`);
console.log(`${people.length} contributors: ${people.map(p => p.login).join(", ")} (left out: ${all.length - people.length})`);
