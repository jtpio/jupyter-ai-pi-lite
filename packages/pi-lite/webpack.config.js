/**
 * Let pi (written for Node) run in the browser: the Node built-ins, some
 * packages and a few pi modules map to the shims, and the Node globals are
 * provided to the modules of this extension only.
 */
const fs = require('fs');
const path = require('path');
const {
  DefinePlugin,
  NormalModuleReplacementPlugin,
  ProvidePlugin
} = require('@rspack/core');

const shim = name => path.join(__dirname, 'shims', name);

/**
 * The exports map of pi-coding-agent hides its package folder, which holds
 * the files pi reads at run time (package.json, themes).
 */
function findPackageDir(name) {
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = path.join(base, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  throw new Error(`Cannot find the ${name} package`);
}

const piPackageDir = findPackageDir('@earendil-works/pi-coding-agent');
const pi = file => path.join(piPackageDir, file);

const BUILTINS = {
  buffer: shim('buffer.cjs'),
  child_process: shim('child-process.cjs'),
  crypto: shim('crypto.cjs'),
  events: require.resolve('events/'),
  fs: shim('fs.cjs'),
  'fs/promises': shim('fs-promises.cjs'),
  http: shim('empty.cjs'),
  module: shim('module.cjs'),
  os: shim('os.cjs'),
  path: require.resolve('path-browserify'),
  perf_hooks: shim('perf-hooks.cjs'),
  process: shim('process.cjs'),
  readline: shim('readline.cjs'),
  'readline/promises': shim('readline.cjs'),
  stream: require.resolve('readable-stream'),
  string_decoder: require.resolve('string_decoder/'),
  'timers/promises': shim('timers-promises.cjs'),
  url: shim('url.cjs'),
  util: shim('util.cjs'),
  worker_threads: shim('empty.cjs'),
  zlib: shim('empty.cjs')
};

/**
 * The packages and the pi modules that need a process, a binary or a file of
 * the computer.
 */
const REPLACED = {
  'cross-spawn': shim('child-process.cjs'),
  jiti: shim('jiti.cjs'),
  'jiti/static': shim('jiti.cjs'),
  'process/browser': shim('process.cjs'),
  'proper-lockfile': shim('lockfile.cjs'),
  undici: shim('undici.cjs'),
  [pi('dist/utils/clipboard.js')]: shim('clipboard.js'),
  [pi('dist/utils/clipboard-image.js')]: shim('clipboard.js'),
  [pi('dist/utils/open-browser.js')]: shim('open-browser.js'),
  [pi('dist/utils/photon.js')]: shim('photon.js'),
  [pi('dist/utils/tools-manager.js')]: shim('tools-manager.js')
};

/**
 * The files that pi reads from its own package with readFileSync, by their
 * path in the fs shim, which seeds them. Of the changelog (`/changelog`,
 * "What's New"), only the entries of the major version of pi: the whole file
 * is large.
 */
function piFiles() {
  const read = file => fs.readFileSync(pi(file), 'utf8');
  const { name, version, piConfig } = JSON.parse(read('package.json'));
  const changelog = read('CHANGELOG.md');
  const major = version.split('.')[0];
  const older = changelog.search(new RegExp(`^## \\[(?!${major}\\.)`, 'm'));
  const files = [
    'README.md',
    ...fs
      .readdirSync(pi('docs'))
      .filter(file => file.endsWith('.md'))
      .map(file => `docs/${file}`),
    'dist/modes/interactive/theme/dark.json',
    'dist/modes/interactive/theme/light.json',
    'dist/core/export-html/template.html',
    'dist/core/export-html/template.css',
    'dist/core/export-html/template.js',
    'dist/core/export-html/vendor/marked.min.js',
    'dist/core/export-html/vendor/marked-cjk-friendly.min.js',
    'dist/core/export-html/vendor/highlight.min.js'
  ];
  return {
    '/pi/package.json': JSON.stringify({ name, version, piConfig }),
    '/pi/CHANGELOG.md': older === -1 ? changelog : changelog.slice(0, older),
    ...Object.fromEntries(files.map(file => [`/pi/${file}`, read(file)]))
  };
}

const timers = shim('node-timers.js');

module.exports = {
  node: { __dirname: 'mock' },
  resolve: {
    alias: {
      ...BUILTINS,
      ...REPLACED,
      // For the pi modules that the exports map hides.
      'pi-coding-agent-package': piPackageDir
    }
  },
  module: {
    parser: { javascript: { url: false } },
    rules: [{ test: /photon_rs_bg\.wasm$/, type: 'asset/resource' }]
  },
  plugins: [
    // An alias does not apply to a request with a scheme.
    new NormalModuleReplacementPlugin(/^node:/, resource => {
      const target = BUILTINS[resource.request.slice(5)];
      if (target) {
        resource.request = target;
      }
    }),
    new DefinePlugin({
      'import.meta.url': JSON.stringify('file:///pi/dist/index.js'),
      __PI_FILES__: JSON.stringify(piFiles())
    }),
    new ProvidePlugin({
      Buffer: [require.resolve('buffer/'), 'Buffer'],
      setTimeout: [timers, 'setTimeout'],
      setInterval: [timers, 'setInterval'],
      clearTimeout: [timers, 'clearTimeout'],
      clearInterval: [timers, 'clearInterval'],
      setImmediate: [timers, 'setImmediate']
    })
  ],
  ignoreWarnings: [/Critical dependency/, /Failed to parse source map/]
};
