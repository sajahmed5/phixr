#!/usr/bin/env node
// Builds the public legal site from the in-app text in constants/legal.ts, so the app and
// the website can never drift apart. Every document in LEGAL_DOC_LIST is published at
// /<id> (for example /terms, /business), with an index page at /.
//
// /privacy is the App Store Connect "Privacy Policy URL": keep that path unchanged.
//
//   npm run legal:build    -> writes .legal-site/
//   npm run legal:deploy   -> builds, then deploys to Vercel project `phixr-legal`
//                             (live at https://phixr-legal.vercel.app)
//
// Re-run legal:deploy whenever any legal text or TERMS_VERSION changes.

/* global __dirname */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'constants', 'legal.ts'), 'utf8');
const outDir = path.resolve(process.argv[2] || path.join(root, '.legal-site'));

function extractDoc(id) {
  const re = new RegExp(
    String.raw`(?:^|\n)\s*` +
      id +
      String.raw`:\s*\{\s*title:\s*'([^']+)',\s*updated:\s*([^,]+),\s*body:\s*\x60([\s\S]*?)\x60,\s*\}`,
  );
  const m = src.match(re);
  if (!m) throw new Error(`Could not find the "${id}" document in constants/legal.ts`);
  return { id, title: m[1], body: m[3] };
}

// Document order + one-line summaries, from LEGAL_DOC_LIST in legal.ts.
function extractList() {
  const block = src.match(/LEGAL_DOC_LIST[^=]*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error('Could not find LEGAL_DOC_LIST in constants/legal.ts');
  const items = [...block[1].matchAll(/\{\s*id:\s*'([a-z]+)',\s*summary:\s*'([^']+)'\s*\}/g)].map(
    (m) => ({ id: m[1], summary: m[2] }),
  );
  if (!items.length) throw new Error('LEGAL_DOC_LIST is empty');
  if (!items.some((d) => d.id === 'privacy')) throw new Error('LEGAL_DOC_LIST must include privacy');
  return items;
}

const versionMatch = src.match(/TERMS_VERSION = '([^']+)'/);
if (!versionMatch) throw new Error('Could not find TERMS_VERSION in constants/legal.ts');
const updated = versionMatch[1];
const updatedHuman = new Date(`${updated}T00:00:00Z`).toLocaleDateString('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const HEADING = /^(\d+)\.\s+[A-Z0-9 ,'()&‐-―-]+$/;
// "Label — text": the label is a short phrase with no sentence punctuation.
const LEAD_IN = /^([^—.:?!\n]{3,60})\s+—\s+([\s\S]+)$/;

// Body format in legal.ts: blank-line-separated blocks; a block may start with a
// numbered ALL-CAPS heading line ("2. WHO WE SHARE DATA WITH"); a block whose lines all
// start with "• " is a list; "Label — text" paragraphs get a bold lead-in; other single
// line breaks inside a paragraph are kept.
function bodyToHtml(body) {
  return body
    .split(/\n\n+/)
    .map((block) => {
      let t = block.trim();
      let out = '';
      const lines = t.split('\n');
      const heading = lines[0].trim().match(HEADING);
      if (heading) {
        out += `<h2 id="s${heading[1]}">${esc(lines[0].trim())}</h2>\n`;
        t = lines.slice(1).join('\n').trim();
        if (!t) return out.trim();
      } else if (/^\d+\.\s+[A-Z]{2}/.test(lines[0].trim())) {
        // Looks like a heading but has a character the format doesn't allow (e.g. "/").
        throw new Error(`Unrecognised section heading: "${lines[0].trim()}"`);
      }
      const rows = t.split('\n').map((l) => l.trim());
      if (rows.every((l) => l.startsWith('• '))) {
        return `${out}<ul>\n${rows.map((l) => `  <li>${esc(l.slice(2))}</li>`).join('\n')}\n</ul>`;
      }
      const para = (s) => esc(s).replace(/\n/g, '<br>\n');
      const dash = t.match(LEAD_IN);
      if (dash) return `${out}<p><strong>${esc(dash[1])}</strong> — ${para(dash[2])}</p>`;
      return `${out}<p>${para(t)}</p>`;
    })
    .join('\n');
}

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0 16px;
    font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #ffffff; color: #1c1c1e;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #111113; color: #e8e8ea; }
    a { color: #7cb3ff; }
    header, .docs li { border-color: #2c2c2e !important; }
    .meta, .docs .summary, footer { color: #98989d !important; }
    .docs a:hover { background: #1c1c1f !important; }
  }
  main { max-width: 42rem; margin: 0 auto; padding: 2.5rem 0 5rem; }
  header { border-bottom: 1px solid #e5e5ea; padding-bottom: 1.25rem; margin-bottom: 1.5rem; }
  .brand { font-weight: 800; letter-spacing: -0.02em; font-size: 1.1rem; margin: 0 0 1.25rem; }
  .brand a { color: inherit; text-decoration: none; }
  h1 { font-size: 2rem; letter-spacing: -0.02em; margin: 0 0 .35rem; }
  .meta { color: #6e6e73; margin: 0; font-size: .95rem; }
  h2 { font-size: 1.15rem; letter-spacing: -0.01em; margin: 2.2rem 0 .6rem; }
  p { margin: 0 0 1rem; }
  ul { margin: 0 0 1rem; padding-left: 1.3rem; }
  li { margin: 0 0 .4rem; }
  a { color: #0a66c2; }
  .docs { list-style: none; padding: 0; margin: 0; }
  .docs li { border-bottom: 1px solid #e5e5ea; margin: 0; }
  .docs a { display: flex; align-items: center; gap: 1rem; padding: 1rem .25rem; text-decoration: none; color: inherit; border-radius: 8px; }
  .docs a:hover { background: #f5f5f7; }
  .docs .text { flex: 1; }
  .docs .name { display: block; font-weight: 650; }
  .docs .summary { display: block; color: #6e6e73; font-size: .95rem; }
  .docs .chev { color: #a1a1a6; font-size: 1.3rem; }
  footer { max-width: 42rem; margin: 0 auto 3rem; font-size: .9rem; color: #6e6e73; }
`;

const page = (title, description, contentHtml, { isIndex = false } = {}) => `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(isIndex ? 'Phixr legal' : `${title} · Phixr`)}</title>
<meta name="description" content="${esc(description)}">
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <p class="brand"><a href="/">Phixr</a></p>
    <h1>${esc(title)}</h1>
    <p class="meta">Last updated ${esc(updatedHuman)} · Contact: <a href="mailto:support@joinphixr.com">support@joinphixr.com</a></p>
  </header>
  ${contentHtml}
</main>
<footer>© ${updated.slice(0, 4)} Phixr. ${
  isIndex
    ? 'These documents are also shown inside the Phixr app under Settings.'
    : 'This document is also shown inside the Phixr app under Settings. <a href="/">All legal documents</a>.'
}</footer>
</body>
</html>
`;

const list = extractList();
const docs = list.map((item) => ({ ...extractDoc(item.id), summary: item.summary }));

const built = [];
for (const doc of docs) {
  const html = page(doc.title, `${doc.title} for the Phixr app. ${doc.summary}`, bodyToHtml(doc.body));
  const sections = (html.match(/<h2[ >]/g) || []).length;
  if (sections === 0) {
    throw new Error(`"${doc.id}" rendered with no section headings — check the body format`);
  }
  fs.mkdirSync(path.join(outDir, doc.id), { recursive: true });
  fs.writeFileSync(path.join(outDir, doc.id, 'index.html'), html);
  built.push(`  /${doc.id.padEnd(11)} ${String(sections).padStart(2)} sections  ${doc.title}`);
}

const indexHtml = page(
  'Legal',
  'Terms, privacy policy and other legal documents for the Phixr app.',
  `<ul class="docs">\n${docs
    .map(
      (d) =>
        `    <li><a href="/${d.id}"><span class="text"><span class="name">${esc(d.title)}</span><span class="summary">${esc(d.summary)}</span></span><span class="chev" aria-hidden="true">›</span></a></li>`,
    )
    .join('\n')}\n  </ul>`,
  { isIndex: true },
);
fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml);

console.log(`Built ${path.relative(root, outDir) || outDir} (version ${updated})`);
console.log('  /            index');
console.log(built.join('\n'));
