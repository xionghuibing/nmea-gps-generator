// @ts-check
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const testOnly = process.argv.includes('--test');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

/**
 * @param {import('esbuild').BuildOptions} options
 */
async function build(options) {
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    return;
  }
  await esbuild.build(options);
}

async function main() {
  if (testOnly) {
    await build({
      ...shared,
      entryPoints: ['src/test/generator.test.ts'],
      outfile: 'out-test/generator.test.cjs',
      platform: 'node',
      format: 'cjs',
      target: 'node20'
    });
    return;
  }

  /** @type {import('esbuild').BuildOptions[]} */
  const builds = [
    {
      ...shared,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['vscode']
    },
    {
      ...shared,
      entryPoints: ['src/webview/main.ts'],
      outfile: 'media/main.js',
      platform: 'browser',
      format: 'iife',
      target: 'es2020'
    }
  ];

  await Promise.all(builds.map(build));
  copyLeafletAssets();
  if (watch) {
    console.log('[esbuild] watching extension + webview sources...');
  }
}

/** Leaflet 的 CSS 和默认控件图片不在 JS bundle 里，需要一起复制到 media/。 */
function copyLeafletAssets() {
  const sourceDir = path.join(__dirname, 'node_modules', 'leaflet', 'dist');
  const targetDir = path.join(__dirname, 'media');
  const sourceCss = path.join(sourceDir, 'leaflet.css');
  if (!fs.existsSync(sourceCss)) {
    console.warn('[esbuild] leaflet is not installed; media/leaflet.css was not generated');
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourceCss, path.join(targetDir, 'leaflet.css'));
  fs.cpSync(path.join(sourceDir, 'images'), path.join(targetDir, 'images'), {
    recursive: true
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
