'use strict';
// Shared by the tests: where the CRM files are, and finance-model.js with the repeat report in it. CRM_DIR = a directory of
// fresh live copies before a deploy. A model that has no repeatReport() yet (the snapshot, a fresh server copy) gets the same
// patch the deploy applies, in a temporary copy; a model that has it (crm-app after the PR, the server after the deploy) is used as it is.
const fs = require('fs');
const os = require('os');
const path = require('path');

const INFRA = fs.existsSync(path.join(__dirname, '..', 'crm', 'finance-view.js'));
const CRM_DIR = process.env.CRM_DIR || (INFRA ? path.join(__dirname, '..', '..', '..', 'server-snapshot', 'var/www/mastersol/html/CRM') : path.join(__dirname, '..', '..'));

// crm-app's package.json says "type": "module", so a classic page script is loaded through a .cjs copy
function load(file, text) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finview-js-')), path.basename(file, '.js') + '.cjs');
  if (text === undefined) fs.copyFileSync(file, tmp); else fs.writeFileSync(tmp, text);
  return require(tmp);
}

// Call after orders-model.js is loaded (the model reaches OrdersModel through the global it sets).
function loadModel() {
  const file = path.join(CRM_DIR, 'finance-model.js');
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes('function repeatReport(')) return load(file);
  const r = require('../deploy/patch-finance-model.cjs').run(src);   // not at the top: crm-app has no deploy/ next to its tests
  if (!r.ok) throw new Error('the repeat report patch does not apply to ' + file + ': ' + r.report.join('; '));
  return load(file, r.out);
}

module.exports = { INFRA, CRM_DIR, load, loadModel };
