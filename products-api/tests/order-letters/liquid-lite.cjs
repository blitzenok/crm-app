'use strict';
// A small renderer for the Liquid these templates use, so the tests can look at what a buyer would read. Not Liquid:
// only {{ path | default: "x" | remove: "x" }}, {% if / elsif / else / endif %} with == != contains > and a bare value,
// {% for x in path %}, and .size. Anything else throws, so a template that starts using more fails the test loudly.

function tokenize(src) {
  const out = [];
  const re = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g;
  let last = 0, m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'out', v: m[1].trim() });
    else out.push({ t: 'tag', v: m[2].trim() });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}
function parse(tokens) {
  let i = 0;
  function block(stops) {
    const nodes = [];
    while (i < tokens.length) {
      const tk = tokens[i];
      if (tk.t === 'tag') {
        const word = tk.v.split(/\s+/)[0];
        if (stops.includes(word)) return { nodes, stop: word, tag: tk.v };
        i++;
        if (word === 'if') {
          const branches = [];
          let cond = tk.v.slice(2).trim();
          for (;;) {
            const b = block(['elsif', 'else', 'endif']);
            branches.push({ cond, nodes: b.nodes });
            if (b.stop === 'elsif') { cond = b.tag.slice(5).trim(); i++; continue; }
            if (b.stop === 'else') { cond = null; i++; const e = block(['endif']); branches.push({ cond: null, nodes: e.nodes }); i++; break; }
            if (b.stop === 'endif') { i++; break; }
            throw new Error('unterminated if');
          }
          nodes.push({ t: 'if', branches });
        } else if (word === 'for') {
          const fm = tk.v.match(/^for\s+(\w+)\s+in\s+([\w.]+)$/);
          if (!fm) throw new Error('unsupported for: ' + tk.v);
          const b = block(['endfor']);
          if (b.stop !== 'endfor') throw new Error('unterminated for');
          i++;
          nodes.push({ t: 'for', v: fm[1], coll: fm[2], nodes: b.nodes });
        } else throw new Error('unsupported tag: ' + tk.v);
      } else { nodes.push(tk); i++; }
    }
    return { nodes, stop: null };
  }
  const r = block([]);
  return r.nodes;
}
function lookup(path, ctx) {
  const parts = path.split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    if (p === 'size') { if (Array.isArray(cur) || typeof cur === 'string') { cur = cur.length; continue; } return undefined; }
    cur = cur[p];
  }
  return cur;
}
function value(expr, ctx) {
  const e = expr.trim();
  let m = e.match(/^"([^"]*)"$/);
  if (m) return m[1];
  if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
  if (e === 'true') return true;
  if (e === 'false') return false;
  if (e === 'nil') return undefined;
  if (!/^[\w.]+$/.test(e)) throw new Error('unsupported expression: ' + e);
  return lookup(e, ctx);
}
function truthy(v) { return v !== undefined && v !== null && v !== false; }
function cond(expr, ctx) {
  const m = expr.match(/^(.+?)\s+(==|!=|contains|>)\s+(.+)$/);
  if (!m) return truthy(value(expr, ctx));
  const a = value(m[1], ctx), b = value(m[3], ctx);
  if (m[2] === '==') return a === b;
  if (m[2] === '!=') return a !== b;
  if (m[2] === '>') return typeof a === 'number' && a > b;
  return typeof a === 'string' && typeof b === 'string' && a.includes(b);
}
function output(expr, ctx) {
  const parts = expr.split('|').map(s => s.trim());
  let v = value(parts[0], ctx);
  for (const f of parts.slice(1)) {
    const fm = f.match(/^(default|remove):\s*"([^"]*)"$/);
    if (!fm) throw new Error('unsupported filter: ' + f);
    if (fm[1] === 'default') { if (!truthy(v) || v === '') v = fm[2]; }
    else v = String(v === undefined ? '' : v).split(fm[2]).join('');
  }
  return v === undefined || v === null ? '' : String(v);
}
function run(nodes, ctx) {
  let s = '';
  for (const n of nodes) {
    if (n.t === 'text') s += n.v;
    else if (n.t === 'out') s += output(n.v, ctx);
    else if (n.t === 'if') { for (const b of n.branches) { if (b.cond === null || cond(b.cond, ctx)) { s += run(b.nodes, ctx); break; } } }
    else if (n.t === 'for') { const list = lookup(n.coll, ctx); for (const item of (Array.isArray(list) ? list : [])) s += run(n.nodes, Object.assign({}, ctx, { [n.v]: item })); }
  }
  return s;
}
function render(src, trigger, extra) { return run(parse(tokenize(src)), Object.assign({ trigger }, extra || {})); }
// The words a reader sees: tags out, entities and runs of space folded.
function readable(html) {
  return html.replace(/<\/(p|h2|tr|td|th|div)>|<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
module.exports = { render, readable, tokenize };
