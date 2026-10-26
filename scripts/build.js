// Builds the single-file app from src/.
//   dist/artifact.html  page content for publishing as a claude.ai artifact (no <html> wrapper)
//   dist/index.html     full standalone page, served by server.js
// Run: node scripts/build.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const exists = f => fs.existsSync(path.join(root, 'src', f));

let page = read('index.template.html');
const parts = {
  STYLES: read('styles.css'),
  CORE: read('core.js'),
  SCENE: read('scene.js'),
  IMMERSIVE: read('immersive.js'),
  AGENT: read('agent.js'),
  EVAL: (exists('eval.js') ? read('eval.js') : '') + '\n' + (exists('about.js') ? read('about.js') : ''),
  APP: read('app.js'),
};
for (const [k, v] of Object.entries(parts)) {
  const marker = k === 'STYLES' ? `/*${k}*/` : `/*${k}*/`;
  if (!page.includes(marker)) throw new Error('Missing marker ' + marker);
  page = page.replace(marker, () => v.replace(/<\/script/gi, '<\\/script'));
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), page);
// Standalone build: load three.js from the local server first (works offline), CDN as fallback.
const local = page
  .replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>',
    '<script src="vendor/three.min.js"></script>\n<script>window.THREE || document.write(\'<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\\/script>\')</script>')
  .replace('<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>',
    '<script src="vendor/OrbitControls.js"></script>\n<script>(window.THREE && THREE.OrbitControls) || document.write(\'<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"><\\/script>\')</script>');
if (local === page) throw new Error('vendor rewrite failed');
const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
</head>
<body>
${local}
</body>
</html>
`;
fs.writeFileSync(path.join(root, 'dist', 'index.html'), full);
console.log('Built dist/artifact.html (' + Math.round(page.length / 1024) + ' KB) and dist/index.html');
