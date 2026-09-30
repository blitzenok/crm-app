/**
 * BioLabs Research CRM — shared output-escaping helpers (phase 1, 2026-09-04).
 * Loaded by every CRM page before its inline scripts. Data rendered through innerHTML must go through these:
 *   esc(x)     — text between tags: & < > " ' become entities
 *   escAttr(x) — attribute values: the same five plus space, = and backtick, so it is safe even in an unquoted attribute
 *   safeUrl(x) — a whole href/src taken from data: http(s):, mailto:, tel: and relative paths pass, empty stays empty, anything else → '#'
 *   safeId(x)  — an id/ref interpolated into an inline handler: [A-Za-z0-9_.:-] only, anything else → ''
 * null/undefined render as an empty string.
 */
(function (global) {
    var MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', ' ': '&#32;', '=': '&#61;', '`': '&#96;' };
    function esc(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/[&<>"']/g, function (c) { return MAP[c]; });
    }
    // Phase 2 (2026-09-05): attribute values also escape space, = and backtick (unquoted-attribute breakouts); esc() is unchanged.
    function escAttr(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/[&<>"' =`]/g, function (c) { return MAP[c]; });
    }
    function safeUrl(s) {
        if (s === null || s === undefined) return '';
        // browsers drop ASCII tab/newline inside a scheme, so strip control characters before looking at it
        var u = String(s).replace(/[\u0000-\u001F\u007F]/g, '').trim();
        if (u === '') return '';
        if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
        if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return '#';   // any other scheme: javascript:, data:, vbscript:, ...
        if (u.indexOf('//') === 0 || u.indexOf('\\') === 0) return '#';  // protocol-relative / backslash tricks
        return u;                                           // relative path, query or fragment
    }
    function safeId(s) {
        if (s === null || s === undefined) return '';
        var v = String(s);
        return /^[A-Za-z0-9_.:\-]+$/.test(v) ? v : '';
    }
    global.esc = esc;
    global.escAttr = escAttr;
    global.safeUrl = safeUrl;
    global.safeId = safeId;
})(typeof window !== 'undefined' ? window : globalThis);
