/**
 * unit-costs.cjs (2026-09-30) - the unit-cost list for the gross margin on the Finance Reports page.
 *
 *   GET /api/unit-costs   the list as stored in data/unit-costs.json:
 *                          { source, currency, updatedAt, items: [{ product, size, id, system, client, cost, match: [{ slug, mg }] }] }
 *
 * Mounted in server_v14.cjs behind requireAuth: supplier prices are staff-only. The file is read on every request, so
 * a new price list takes effect without a restart. Source and build script: biofirst-hosting services/finance-margin.
 * Plain (req, res, next) handler, no express dependency, so it is testable with node:http.
 */
'use strict';
const fs = require('fs');

module.exports = function unitCosts(opts) {
  const file = opts && opts.file;
  function send(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
  return function unitCostsHandler(req, res, next) {
    const pathname = String(req.url || '/').split('?')[0];
    if (req.method !== 'GET' || (pathname !== '/' && pathname !== '')) return next();
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      return send(res, e && e.code === 'ENOENT' ? 404 : 500, { error: e && e.code === 'ENOENT' ? 'no unit cost list' : 'unit cost list unreadable' });
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { return send(res, 500, { error: 'unit cost list unreadable' }); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return send(res, 500, { error: 'unit cost list unreadable' });
    send(res, 200, data);
  };
};
