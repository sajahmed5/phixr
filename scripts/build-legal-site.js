#!/usr/bin/env node
// Builds the public privacy-policy page (the App Store Connect "Privacy Policy URL")
// from the in-app text in constants/legal.ts, so the two can never drift apart.
//
//   npm run legal:build    -> writes .legal-site/
//   npm run legal:deploy   -> builds, then deploys to Vercel project `phixr-legal`
//                             (live at https://phixr-legal.vercel.app/privacy)
//
// Re-run legal:deploy whenever the privacy text or TERMS_VERSION changes.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'constants', 'legal.ts'), 'utf8');
const outDir = path.resolve(process.argv[2] || path.join(root, '.legal-site'));

function extractDoc(id) {
  const re = new RegExp(
    id + String.raw`:\s*\{\s*title:\s*'([^']+)',\s*updated:\s*([^,]+),\s*body:\s*\x60([\s\S]*?)\x60,\s*\}`,
    'm',
  );
  const m = src.match(re);
  if (!m) throw new Error(`Could not find the "${id}" document in constants/legal.ts`);
  return { title: m[1], body: m[3] };
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

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Body format in legal.ts: blank-line-separated blocks; a block may start with a
// numbered ALL-CAPS heading line ("2. WHO WE SHARE DATA WITH"); "Label — text"
// paragraphs get a bold lead-in.
function bodyToHtml(body) {
  return body
    .split(/\n\n+/)
    .map((block) => {
      let t = block.trim();
      let out = '';
      const lines = t.split('\n');
      if (/^\d+\.\s+[A-Z0-9 ,'()&‐-―-]+$/.test(lines[0].trim())) {
        out += `<h2>${esc(lines[0].trim())}</h2>\n`;
        t = lines.slice(1).join('\n').trim();
        if (!t) return out.trim();
      }
      const dash = t.match(/^([^—\n]{3,60})\s+—\s+([\s\S]+)$/);
      if (dash) return `${out}<p><strong>${esc(dash[1])}</strong> — ${esc(dash[2])}</p>`;
      return `${out}<p>${esc(t)}</p>`;
    })
    .join('\n');
}

const page = (title, contentHtml) => `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Phixr</title>
<meta name="description" content="${esc(title)} for the Phixr app.">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0 16px;
    font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #ffffff; color: #1c1c1e;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #111113; color: #e8e8ea; }
    a { color: #7cb3ff; }
    header { border-color: #2c2c2e !important; }
    .meta { color: #98989d !important; }
  }
  main { max-width: 42rem; margin: 0 auto; padding: 2.5rem 0 5rem; }
  header { border-bottom: 1px solid #e5e5ea; padding-bottom: 1.25rem; margin-bottom: 1.5rem; }
  .brand { font-weight: 800; letter-spacing: -0.02em; font-size: 1.1rem; margin: 0 0 1.25rem; }
  h1 { font-size: 2rem; letter-spacing: -0.02em; margin: 0 0 .35rem; }
  .meta { color: #6e6e73; margin: 0; font-size: .95rem; }
  h2 { font-size: 1.15rem; letter-spacing: -0.01em; margin: 2.2rem 0 .6rem; }
  p { margin: 0 0 1rem; }
  a { color: #0a66c2; }
  footer { max-width: 42rem; margin: 0 auto 3rem; font-size: .9rem; color: #6e6e73; }
</style>
</head>
<body>
<main>
  <header>
    <p class="brand">Phixr</p>
    <h1>${esc(title)}</h1>
    <p class="meta">Last updated ${esc(updatedHuman)} · Contact: support@joinphixr.com</p>
  </header>
  ${contentHtml}
</main>
<footer>© ${updated.slice(0, 4)} Phixr. This policy is also shown inside the Phixr app under Settings.</footer>
</body>
</html>
`;

const privacy = extractDoc('privacy');
const html = page(privacy.title, bodyToHtml(privacy.body));
const sections = (html.match(/<h2>/g) || []).length;
if (sections === 0) throw new Error('Privacy policy rendered with no section headings — check the body format');

fs.mkdirSync(path.join(outDir, 'privacy'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'privacy', 'index.html'), html);
fs.writeFileSync(
  path.join(outDir, 'index.html'),
  '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/privacy"><title>Phixr</title></head><body><p><a href="/privacy">Phixr Privacy Policy</a></p></body></html>\n',
);
console.log(`Built ${path.relative(root, outDir) || outDir}/privacy (${sections} sections, version ${updated})`);
