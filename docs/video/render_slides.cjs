#!/usr/bin/env node
// Generates one self-contained HTML slide per scene in scenes.json (plain Node, no dependencies).
const fs = require("fs");
const path = require("path");

const WORK = process.env.VIDEO_DIR || __dirname;
const scenes = JSON.parse(fs.readFileSync(path.join(WORK, "scenes.json"), "utf8"));
const OUT_DIR = path.join(WORK, "slides");
fs.mkdirSync(OUT_DIR, { recursive: true });

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0a0a0a; color: #fff;
    font-family: 'DejaVu Sans',Arial,'Noto Color Emoji',sans-serif; }
  body { background: radial-gradient(circle at 85% 10%, #2b2a00 0%, #0a0a0a 55%); }
  .frame { width: 1920px; height: 1080px; padding: 90px 140px 70px; display: flex; flex-direction: column; }
  .badge { font-size: 30px; letter-spacing: 3px; font-weight: 800; color: #FFFC00; text-transform: uppercase; margin-bottom: 26px; }
  .badge::before { content: "\\1F47B  "; }
  h1 { font-size: 76px; line-height: 1.1; margin: 0 0 40px; font-weight: 800; }
  .content { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .footer { font-size: 26px; color: #8a8a5a; margin-top: 24px; }
  ul.bullets { list-style: none; padding: 0; margin: 0; }
  ul.bullets li { font-size: 46px; padding: 26px 0 26px 76px; position: relative; border-bottom: 1px solid #2a2a2a; line-height: 1.25; }
  ul.bullets li::before { content: ""; position: absolute; left: 0; top: 40px; width: 30px; height: 30px; border-radius: 50%; background: #FFFC00; }
  .stats { display: flex; gap: 50px; }
  .stat { flex: 1; background: #151515; border: 2px solid #FFFC00; border-radius: 28px; padding: 60px 40px; text-align: center; }
  .stat .n { font-size: 190px; font-weight: 800; color: #FFFC00; line-height: 1; }
  .stat .l { font-size: 38px; color: #ddd; margin-top: 24px; }
  .note { font-size: 30px; color: #999; margin-top: 40px; }
  .quote { font-size: 110px; line-height: 1.12; font-weight: 800; }
  .quote em { color: #FFFC00; font-style: normal; }
  .term { font-family: 'DejaVu Sans Mono','Noto Color Emoji', monospace; font-size: 31px; line-height: 1.42; background: #111; border: 1px solid #333;
    border-radius: 20px; padding: 34px 46px; white-space: pre-wrap; box-shadow: 0 24px 70px rgba(255,252,0,.08); color: #e8e8e8; }
  .term .prompt { color: #FFFC00; font-weight: 700; }
  .term .dim { color: #7d7d7d; }
  .term .add { color: #6ee787; }
  .twocol { display: flex; gap: 60px; }
  .card { flex: 1; border-radius: 28px; padding: 56px; font-size: 42px; line-height: 1.8; white-space: pre-line; }
  .card h2 { font-size: 56px; margin: 0 0 20px; }
  .card.a { background: #151515; border: 2px solid #444; color: #bbb; }
  .card.b { background: #FFFC00; color: #000; }
  .center { align-items: center; text-align: center; }
  .hero { font-size: 210px; font-weight: 800; color: #FFFC00; letter-spacing: -6px; }
  .tag { font-size: 54px; color: #ddd; }
  .cmd { font-family: 'DejaVu Sans Mono', monospace; font-size: 44px; background: #111; border: 1px solid #FFFC00; border-radius: 16px;
    padding: 22px 40px; margin: 14px 0; text-align: left; min-width: 1000px; }
  .cmd::before { content: "$ "; color: #FFFC00; }
  ul.src { font-size: 32px; line-height: 1.7; color: #ddd; padding-left: 40px; }
`;

const shell = (inner, footer) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${inner}</body></html>`;

function colorize(code) {
  return code.split("\n").map((l) => {
    const e = esc(l);
    if (l.startsWith("$ ")) return `<span class="prompt">$</span> ${e.slice(2)}`;
    if (l.startsWith("(")) return `<span class="dim">${e}</span>`;
    if (l.startsWith("+") && !l.startsWith("+++")) return `<span class="add">${e}</span>`;
    return e;
  }).join("\n");
}

function render(s) {
  const head = s.title ? `<div class="badge">snapgit</div><h1>${esc(s.title)}</h1>` : "";
  const foot = `<div class="footer">snapgit · github.com/Tiobold/snapgit</div>`;
  let body;
  switch (s.kind) {
    case "title":
      return shell(`<div class="frame" style="justify-content:center"><div class="content center">
        <div class="hero">👻 ${esc(s.title)}</div><div class="tag">${esc(s.subtitle)}</div></div></div>`);
    case "bullets":
      body = `<div class="content"><ul class="bullets">${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`; break;
    case "stats":
      body = `<div class="content"><div class="stats">${s.stats.map(([n, l]) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join("")}</div>
        <div class="note">${esc(s.note)}</div></div>`; break;
    case "quote":
      body = `<div class="content"><div class="quote">${esc(s.quote)}<br><em>${esc(s.sub)}</em></div></div>`; break;
    case "terminal":
      body = `<div class="content"><div class="term">${colorize(s.code)}</div></div>`; break;
    case "twocol":
      body = `<div class="content"><div class="twocol"><div class="card a"><h2>${esc(s.colA_title)}</h2>${esc(s.colA_body)}</div>
        <div class="card b"><h2>${esc(s.colB_title)}</h2>${esc(s.colB_body)}</div></div></div>`; break;
    case "outro":
      return shell(`<div class="frame" style="justify-content:center"><div class="content center">
        <div class="hero" style="font-size:130px">👻 ${esc(s.subtitle)}</div>
        ${s.items.map((i) => `<div class="cmd">${esc(i)}</div>`).join("")}
        <div class="note" style="font-size:36px">${esc(s.footer)}</div></div></div>`);
    case "sources":
      body = `<div class="content"><ul class="src">${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul><div class="note">${esc(s.note)}</div></div>`; break;
    default:
      body = "";
  }
  return shell(`<div class="frame">${head}${body}${foot}</div>`);
}

for (const s of scenes) {
  fs.writeFileSync(path.join(OUT_DIR, `${s.id}.html`), render(s), "utf8");
  console.log("wrote", s.id);
}
