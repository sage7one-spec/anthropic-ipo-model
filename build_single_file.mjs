// Bundles index.html + model.js + snapshot.js + Chart.js into ONE html file that opens straight
// from disk (file://) — the copy that lives in the vault. Live data still loads when online.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const strip = (src) => src.replace(/^export\s+(?=(const|function|let|class)\b)/gm, '');
const model = strip(readFileSync('model.js', 'utf8'));
const snap = strip(readFileSync('snapshot.js', 'utf8'));
const chart = readFileSync('vendor/chart.umd.min.js', 'utf8');
let html = readFileSync('index.html', 'utf8');
const chartTag = '<script src="./vendor/chart.umd.min.js"></script>';
if (!html.includes(chartTag)) throw new Error('chart tag not found');
html = html.replace(chartTag, () => `<script>${chart}</script>`);
const imp = /import \{[\s\S]*?\} from '\.\/model\.js';\nimport \{ BAKED_SNAPSHOT \} from '\.\/snapshot\.js';\n/;
if (!imp.test(html)) throw new Error('module imports not found');
html = html.replace(imp, () => `// ---- model.js (inlined) ----\n${model}\n// ---- snapshot.js (inlined) ----\n${snap}\n`);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/anthropic-ipo-model.html', html);
console.log('dist/anthropic-ipo-model.html', (html.length / 1024).toFixed(0) + ' KB');
