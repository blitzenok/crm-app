'use strict';
/**
 * Tiny SVG charts for CRM reports. No libraries, no animation.
 * Spec: docs/superpowers/specs/2026-09-21-crm-nav-finance.md §4.3
 */
(function (global) {
  var PALETTE = ['#10B981', '#1B2A4A', '#F59E0B', '#3B82F6', '#8B5CF6', '#94A3B8'];
  var DEFAULT_COLOR = '#10B981';

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function ariaText(items, kind) {
    var labels = (items || []).map(function (it) { return String(it.label || '').replace(/"/g, ''); }).filter(Boolean);
    var head = kind === 'donut' ? 'Donut chart' : (kind === 'hbars' ? 'Horizontal bar chart' : 'Bar chart');
    return labels.length ? head + ': ' + labels.join(', ') : head;
  }

  function svgOpen(viewBox, aria, height) {
    return '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc(aria) + '" viewBox="' + viewBox + '" width="100%"' + (height ? ' height="' + height + '"' : '') + '>';
  }

  function emptySvg() {
    return svgOpen('0 0 320 120', 'No data') + '<text x="160" y="64" text-anchor="middle" fill="#94A3B8" font-size="14">No data</text></svg>';
  }

  function bars(opts) {
    opts = opts || {};
    var items = Array.isArray(opts.items) ? opts.items : [];
    var format = typeof opts.format === 'function' ? opts.format : String;
    var height = Number(opts.height);
    if (!Number.isFinite(height) || height <= 0) height = 160;
    var color = opts.color || DEFAULT_COLOR;
    if (!items.length) return emptySvg();
    var W = 400, padL = 8, padR = 8, padT = 22, padB = 28;
    var innerW = W - padL - padR;
    var innerH = height;
    var vbH = padT + innerH + padB;
    var max = 0;
    items.forEach(function (it) { var v = num(it.value); if (v > max) max = v; });
    if (max <= 0) max = 1;
    var slot = innerW / items.length;
    var bw = Math.max(2, slot * 0.6);
    var parts = [svgOpen('0 0 ' + W + ' ' + vbH, ariaText(items, 'bars'), height)];
    items.forEach(function (it, i) {
      var v = num(it.value);
      var h = innerH * (v / max);
      var x = padL + i * slot + (slot - bw) / 2;
      var y = padT + innerH - h;
      parts.push('<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + h.toFixed(2) + '" fill="' + esc(color) + '"/>');
      parts.push('<text x="' + (x + bw / 2).toFixed(2) + '" y="' + Math.max(12, y - 4).toFixed(2) + '" text-anchor="middle" font-size="10" fill="#1B2A4A">' + esc(format(v)) + '</text>');
      parts.push('<text x="' + (x + bw / 2).toFixed(2) + '" y="' + (vbH - 8) + '" text-anchor="middle" font-size="10" fill="#5A6685">' + esc(it.label) + '</text>');
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function hbars(opts) {
    opts = opts || {};
    var items = Array.isArray(opts.items) ? opts.items : [];
    var format = typeof opts.format === 'function' ? opts.format : String;
    var color = opts.color || DEFAULT_COLOR;
    if (!items.length) return emptySvg();
    var rowH = 28, padL = 110, padR = 72, padT = 8, padB = 8, W = 480;
    var H = padT + items.length * rowH + padB;
    var max = 0;
    items.forEach(function (it) { var v = num(it.value); if (v > max) max = v; });
    if (max <= 0) max = 1;
    var barW = W - padL - padR;
    var parts = [svgOpen('0 0 ' + W + ' ' + H, ariaText(items, 'hbars'))];
    items.forEach(function (it, i) {
      var v = num(it.value);
      var w = barW * (v / max);
      var y = padT + i * rowH;
      parts.push('<text x="8" y="' + (y + 16) + '" font-size="11" fill="#1B2A4A">' + esc(it.label) + '</text>');
      parts.push('<rect x="' + padL + '" y="' + (y + 6) + '" width="' + w.toFixed(2) + '" height="14" fill="' + esc(color) + '"/>');
      parts.push('<text x="' + (padL + w + 6).toFixed(2) + '" y="' + (y + 17) + '" font-size="10" fill="#5A6685">' + esc(format(v)) + '</text>');
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function polar(cx, cy, r, deg) {
    var a = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function donut(opts) {
    opts = opts || {};
    var items = Array.isArray(opts.items) ? opts.items : [];
    var colors = Array.isArray(opts.colors) && opts.colors.length ? opts.colors : PALETTE;
    if (!items.length) return emptySvg();
    var cx = 80, cy = 80, r = 56, rIn = 32;
    var legendX = 180;
    var H = Math.max(160, 16 + items.length * 18);
    var parts = [svgOpen('0 0 400 ' + H, ariaText(items, 'donut'))];
    var total = 0;
    items.forEach(function (it) { total += num(it.value); });
    var angle = 0;
    items.forEach(function (it, i) {
      var v = num(it.value);
      var color = colors[i % colors.length];
      var sweep = total > 0 ? 360 * (v / total) : 0;
      if (total > 0 && sweep >= 359.99) {
        // A 360° arc collapses, so draw the full ring as a stroked circle (still a donut, one shape per item).
        parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + ((r + rIn) / 2) + '" fill="none" stroke="' + esc(color) + '" stroke-width="' + (r - rIn) + '"/>');
      } else if (sweep <= 0) {
        parts.push('<path d="M ' + cx + ' ' + cy + ' Z" fill="' + esc(color) + '"/>');
      } else {
        var a1 = angle, a2 = angle + sweep;
        var p1 = polar(cx, cy, r, a1), p2 = polar(cx, cy, r, a2);
        var q1 = polar(cx, cy, rIn, a1), q2 = polar(cx, cy, rIn, a2);
        var large = sweep > 180 ? 1 : 0;
        var d = 'M ' + p1[0].toFixed(3) + ' ' + p1[1].toFixed(3)
          + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p2[0].toFixed(3) + ' ' + p2[1].toFixed(3)
          + ' L ' + q2[0].toFixed(3) + ' ' + q2[1].toFixed(3)
          + ' A ' + rIn + ' ' + rIn + ' 0 ' + large + ' 0 ' + q1[0].toFixed(3) + ' ' + q1[1].toFixed(3)
          + ' Z';
        parts.push('<path d="' + d + '" fill="' + esc(color) + '"/>');
      }
      angle += sweep;
      var ly = 20 + i * 18;
      parts.push('<rect x="' + legendX + '" y="' + (ly - 8) + '" width="10" height="10" fill="' + esc(color) + '"/>');
      parts.push('<text x="' + (legendX + 16) + '" y="' + ly + '" font-size="12" fill="#1B2A4A">' + esc(it.label) + '</text>');
    });
    parts.push('</svg>');
    return parts.join('');
  }

  var api = { bars: bars, hbars: hbars, donut: donut };
  global.CrmCharts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : global);
