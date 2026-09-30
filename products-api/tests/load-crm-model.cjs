// The CRM page models (crm-web/*.js) are classic scripts that set module.exports when it exists. The repo root package.json
// says "type": "module", so require() of a .js file here would load them as ES modules and get nothing; a .cjs copy in the
// temp dir loads them the way the browser-side code expects.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function loadCrmModel(name) {
  const src = path.join(__dirname, '..', '..', 'crm-web', name);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-model-')), path.basename(name, '.js') + '.cjs');
  fs.copyFileSync(src, tmp);
  return require(tmp);
};
