import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const repo = path.resolve(here, '..', '..');
const watch = process.argv.includes('--watch');

// Native or asset-bearing packages cannot be bundled: PGlite loads its wasm and
// extension archives from disk, jsdom spawns a worker from its own package
// directory, electron-updater resolves its own files next to the app, and `pg`
// is only reached by a self-hosted server, never here.
const external = ['electron', '@electric-sql/pglite', 'electron-updater', 'jsdom', 'pg'];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20', // Electron 33 ships Node 20
  // Source maps roughly triple the bundle, so they are a development aid only.
  sourcemap: watch,
  // Bundling renames colliding classes, and some dependencies identify types by
  // `constructor.name` rather than instanceof — Hocuspocus decides whether a
  // hook returned a Y.Doc that way. Renaming turns that into silent wrong
  // behaviour rather than an error, so preserve the original names.
  keepNames: true,
  logLevel: 'info',
  external,
};

const builds = [
  {
    ...common,
    entryPoints: [path.join(here, 'src/main/index.ts')],
    outdir: dist,
    format: 'esm',
    // Splitting keeps dynamic imports lazy, which matters: importing the API
    // evaluates its config, and that must not happen until the local server is
    // actually starting and the environment is set.
    splitting: true,
    outExtension: { '.js': '.mjs' },
    // Without explicit names the entry picks up a content hash, and package.json
    // has to point at a fixed file.
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    // Bundling CommonJS dependencies into ESM leaves calls to `require` that
    // esbuild stubs with a throwing shim. Its shim defers to a real `require`
    // if one is in scope, so supply one built from this module's URL.
    banner: {
      js: [
        "import { createRequire as __paradocsCreateRequire } from 'node:module';",
        'const require = __paradocsCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  },
  {
    ...common,
    entryPoints: [path.join(here, 'src/preload/index.ts')],
    outfile: path.join(dist, 'preload.cjs'),
    format: 'cjs',
  },
  {
    ...common,
    platform: 'browser',
    entryPoints: [path.join(here, 'src/shell/shell.ts')],
    outfile: path.join(dist, 'shell/shell.js'),
    format: 'iife',
    external: [],
  },
];

function copyDir(from, to) {
  if (!fs.existsSync(from)) throw new Error(`Missing build input: ${from}`);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

function copyAssets() {
  fs.mkdirSync(path.join(dist, 'shell'), { recursive: true });
  for (const file of ['index.html', 'shell.css']) {
    fs.copyFileSync(path.join(here, 'src/shell', file), path.join(dist, 'shell', file));
  }
  // The migrations run against the local PGlite database, and the built client
  // is what the proxy serves. Both travel with the bundle.
  copyDir(path.join(repo, 'apps/api/migrations'), path.join(dist, 'resources/migrations'));
  copyDir(path.join(repo, 'apps/web/dist'), path.join(dist, 'resources/web'));
}

if (watch) {
  copyAssets();
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching for changes');
} else {
  // Chunk names carry a content hash, so stale ones would otherwise pile up
  // and get packaged.
  fs.rmSync(dist, { recursive: true, force: true });
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyAssets();
  console.log('desktop bundle written to dist/');
}
