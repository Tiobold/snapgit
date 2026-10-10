#!/usr/bin/env node
// scenes.json -> one 1080x1920 (9:16) HTML slide per scene. Plain Node, no dependencies.
// Layout respects TikTok's UI: ~170px top, ~330px bottom, ~140px right stay clear of text that matters.
const fs = require("fs");
const path = require("path");

const WORK = process.env.VIDEO_DIR || __dirname;
const scenes = JSON.parse(fs.readFileSync(path.join(WORK, "scenes.json"), "utf8"));
const OUT_DIR = path.join(WORK, "slides");
fs.mkdirSync(OUT_DIR, { recursive: true });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; background: #0a0a0a; color: #fff;
    font-family: 'DejaVu Sans', Arial, 'Noto Color Emoji', sans-serif; }
  body { background: radial-gradient(circle at 90% 6%, #3a3900 0%, #0a0a0a 55%); }
  .frame { width: 1080px; height: 1920px; padding: 190px 150px 340px 70px; display: flex; flex-direction: column; justify-content: center; gap: 48px; }
  .kicker { font-size: 46px; font-weight: 800; letter-spacing: 4px; text-transform: uppercase; color: #FFFC00; }
  .big { font-size: 150px; line-height: 1.04; font-weight: 800; letter-spacing: -2px; }
  .big em { font-style: normal; color: #000; background: #FFFC00; padding: 0 .12em; border-radius: .14em; }
  .sub { font-size: 62px; line-height: 1.25; color: #d8d8d0; }
  .hero { font-size: 210px; font-weight: 800; color: #FFFC00; letter-spacing: -6px; line-height: 1; }
  .stat { background: #151515; border: 3px solid #FFFC00; border-radius: 36px; padding: 44px 40px; }
  .stat .n { font-size: 230px; font-weight: 800; color: #FFFC00; line-height: 1; }
  .stat .l { font-size: 52px; color: #ddd; margin-top: 8px; }
  .note { font-size: 34px; color: #999; }
  .term { font-family: 'DejaVu Sans Mono', 'Noto Color Emoji', monospace; font-size: 41px; line-height: 1.4; background: #111; border: 1px solid #333;
    border-radius: 28px; padding: 40px 38px; white-space: pre-wrap; word-break: break-word; color: #e8e8e8; box-shadow: 0 30px 80px rgba(255,252,0,.08); }
  .term .p { color: #FFFC00; font-weight: 700; } .term .dim { color: #7d7d7d; } .term .add { color: #6ee787; }
  .term .fuse { color: #FFFC00; font-weight: 700; }
  .cap { font-size: 86px; line-height: 1.12; font-weight: 800; }
  .cap span { background: #FFFC00; color: #000; padding: 0 .2em; border-radius: .16em; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  .cta { font-family: 'DejaVu Sans Mono', monospace; font-size: 46px; border: 3px solid #FFFC00; border-radius: 22px; padding: 26px 30px; word-break: break-all; }
  .tag { font-size: 44px; color: #aaa; }
`;
const page = (inner) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="frame">${inner}</div></body></html>`;

function colorize(code) {
  return code.split("\n").map((l) => {
    const e = esc(l);
    if (l.startsWith("$ ")) return `<span class="p">$</span> ${e.slice(2)}`;
    if (l.startsWith("(")) return `<span class="dim">${e}</span>`;
    if (l.startsWith("+") && !l.startsWith("+++")) return `<span class="add">${e}</span>`;
    if (l.startsWith("⏳")) return `<span class="fuse">${e}</span>`;
    return e;
  }).join("\n");
}

function render(s) {
  switch (s.kind) {
    case "hook":
      return page(`<div class="kicker">${esc(s.kicker)}</div><div class="big">${esc(s.big)}</div><div class="sub">${esc(s.sub)}</div>`);
    case "stats":
      return page(`${s.stats.map(([n, l]) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join("")}<div class="note">${esc(s.note)}</div>${s.caption ? `<div class="cap"><span>${esc(s.caption)}</span></div>` : ""}`);
    case "title":
      return page(`<div class="hero">👻 ${esc(s.big)}</div><div class="big" style="font-size:96px">${esc(s.sub)}</div>`);
    case "terminal":
      return page(`<div class="kicker">${esc(s.kicker)}</div><div class="term">${colorize(s.code)}</div><div class="cap"><span>${esc(s.caption)}</span></div>`);
    case "outro":
      return page(`<div class="big">👻 ${esc(s.big)}<br><em>${esc(s.sub)}</em></div><div class="cta">${esc(s.cta)}</div><div class="tag">${esc(s.tag)}</div>`);
    default:
      return page("");
  }
}

for (const s of scenes) {
  fs.writeFileSync(path.join(OUT_DIR, `${s.id}.html`), render(s), "utf8");
  console.log("wrote", s.id);
}
