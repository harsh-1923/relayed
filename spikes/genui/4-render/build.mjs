// Builds three pages for spike 4, each served under relayed's exact renderer CSP:
//   dev/      NODE_ENV=development, no guard   — what `vite dev` would do today
//   guarded/  NODE_ENV=development, guard on   — the proposed fix
//   prod/     NODE_ENV=production              — what ships
// plus a React-only bundle, so the size OpenUI adds can be read off.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const appCsp = readFileSync('../../../apps/desktop/src/renderer/index.html', 'utf8')
  .match(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/)[0];

const css = `body{font:13px system-ui;margin:16px;background:#fafafa}.message{border:1px solid #ddd;border-radius:8px;padding:10px;margin:0 0 12px;background:#fff}
.label{font:11px monospace;color:#888;margin-bottom:6px}.card{display:flex;flex-direction:column;gap:8px}.stack{display:flex;gap:8px}.stack.column{flex-direction:column}
.muted{color:#777}.stat{border:1px solid #eee;border-radius:6px;padding:6px 10px;display:flex;flex-direction:column}.tone-success b{color:#157f3b}.tone-danger b{color:#b42318}
table{border-collapse:collapse}td,th{border:1px solid #eee;padding:3px 6px;text-align:left;vertical-align:top}.callout{border-left:3px solid #999;padding:4px 8px;background:#f4f4f4}
.actions{display:flex;gap:6px}button{border:1px solid #ccc;border-radius:6px;background:#fff;padding:4px 10px}button.primary{background:#111;color:#fff}.fallback{white-space:pre-wrap;color:#b42318}
.chart .bar-row{display:flex;gap:6px;align-items:center}.chart i{display:inline-block;height:8px;background:#6b7cff}`;

async function page(dir, entry, nodeEnv) {
  mkdirSync(`dist/${dir}`, { recursive: true });
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', minify: nodeEnv === 'production',
    outfile: `dist/${dir}/app.js`, platform: 'browser', target: 'es2022',
    define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) }, loader: { '.json': 'json' },
    logLevel: 'error',
  });
  writeFileSync(`dist/${dir}/index.html`, `<!doctype html><html><head><meta charset="utf-8">${appCsp}
<link rel="stylesheet" href="app.css"><title>genui spike 4 — ${dir}</title></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>`);
  writeFileSync(`dist/${dir}/app.css`, css);
  return statSync(`dist/${dir}/app.js`).size;
}

const sizes = {
  dev: await page('dev', 'page.mjs', 'development'),
  guarded: await page('guarded', 'entry-guarded.mjs', 'development'),
  prod: await page('prod', 'entry-guarded.mjs', 'production'),
  reactOnlyProd: await page('react-only', 'react-only.mjs', 'production'),
};
writeFileSync('../results/4-bundle-sizes.json', JSON.stringify({
  ...sizes, openuiAddsProdBytes: sizes.prod - sizes.reactOnlyProd,
  note: 'prod includes the spike library, renderers and three result fixtures (~40 KB of JSON)',
}, null, 2));
console.log(sizes);
