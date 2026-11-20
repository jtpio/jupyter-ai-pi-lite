const { env } = require('process');

module.exports = {
  homedir: () => env.HOME,
  tmpdir: () => '/tmp',
  release: () => '6.0.0-browser',
  constants: { signals: {} }
};
