/*! checkout field validation: rules (pure, tested in tests/checkout-validate.test.cjs) + live wiring for checkout.html */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BLRCheckoutValidate = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FIELDS = ['firstName', 'lastName', 'email', 'phone', 'address1', 'address2', 'city', 'state', 'zip', 'country'];
  var CONTACT_FIELDS = ['firstName', 'lastName', 'email', 'phone'];
  var REQUIRED = { firstName: 1, lastName: 1, email: 1, address1: 1, city: 1, state: 1, zip: 1, country: 1 };
  var LABELS = {
    firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', address1: 'Address',
    address2: 'Address line 2', city: 'City', state: 'State', zip: 'Postal code', country: 'Country'
  };

  /* Letters and marks, then an optional digit suffix such as "3rd". NFC is applied before the test. */
  var NAME_RE = /^[\p{L}][\p{L}\p{M} .'’\-]*[0-9]*[\p{L}\p{M}]*$/u;
  var CITY_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .'’\-]*$/u;
  var LOCAL_RE = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
  var LABEL_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
  var TLD_RE = /^[\p{L}]{2,24}$/u;

  /* Suggestions are only for these four hosts, and only for a real typo (edit distance 1–2). */
  var PROVIDERS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
  /* Exact domains that are real addresses. Never "correct" one of these, and never jump from a
     TLD typo of one of them onto a different provider (mail.con stays mail.com, not gmail.com). */
  var KNOWN_REAL = {
    'gmail.com': 1, 'yahoo.com': 1, 'hotmail.com': 1, 'outlook.com': 1, 'icloud.com': 1,
    'proton.me': 1, 'protonmail.com': 1, 'aol.com': 1, 'live.com': 1, 'msn.com': 1, 'me.com': 1,
    'mail.com': 1, 'email.com': 1, 'ymail.com': 1, 'gmx.com': 1, 'comcast.net': 1, 'verizon.net': 1,
    'att.net': 1, 'cloud.com': 1, 'horizon.net': 1, 'google.com': 1, 'googlemail.com': 1,
    'mac.com': 1, 'pm.me': 1, 'fastmail.com': 1, 'zoho.com': 1, 'hey.com': 1, 'mail.ru': 1,
    'yandex.com': 1, 'yandex.ru': 1, 'qq.com': 1, '163.com': 1, 'outlook.co': 1, 'hotmail.co': 1,
    'yahoo.co': 1, 'gmail.co': 1, 'icloud.co': 1
  };
  var TLD_TYPOS = { con: 'com', cmo: 'com' };

  function str(v) { return String(v == null ? '' : v).trim(); }

  function nfc(v) {
    v = str(v);
    try { if (v.normalize) v = v.normalize('NFC'); } catch (e) {}
    return v;
  }

  function emailProblem(value) {
    var v = nfc(value);
    var msg = 'Enter a valid email, like you@lab.org.';
    var at = v.lastIndexOf('@');
    if (at < 1 || v.length > 254) return msg;
    var local = v.slice(0, at);
    var labels = v.slice(at + 1).split('.');
    if (local.length > 64 || !LOCAL_RE.test(local) || labels.length < 2) return msg;
    for (var i = 0; i < labels.length; i++) if (!LABEL_RE.test(labels[i])) return msg;
    if (!TLD_RE.test(labels[labels.length - 1])) return msg;
    return '';
  }

  /* Damerau-Levenshtein (adjacent swaps count as one edit) */
  function distance(a, b) {
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 0; j <= b.length; j++) { d[0][j] = j; }
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  /* "a@gmial.com" -> "a@gmail.com". '' when the domain is already real or not a short-list typo.
     A .con/.cmo ending is fixed in place. mail.con becomes mail.com, never gmail.com. */
  function emailSuggestion(value) {
    var v = str(value);
    var at = v.lastIndexOf('@');
    if (at < 1) return '';
    var local = v.slice(0, at);
    var domain = v.slice(at + 1).toLowerCase();
    var labels = domain.split('.');
    if (labels.length !== 2 || !labels[0] || !labels[1]) return '';
    if (KNOWN_REAL[domain]) return '';
    var name = labels[0];
    var tld = labels[1];
    var tldFixed = TLD_TYPOS[tld] ? name + '.' + TLD_TYPOS[tld] : '';
    if (tldFixed && KNOWN_REAL[tldFixed]) return local + '@' + tldFixed;
    var best = '';
    var bestDist = 99;
    for (var i = 0; i < PROVIDERS.length; i++) {
      var p = PROVIDERS[i];
      var dot = p.indexOf('.');
      var pn = p.slice(0, dot);
      var pt = p.slice(dot + 1);
      var tldOk = tld === pt || TLD_TYPOS[tld] === pt;
      if (!tldOk) continue;
      var nd = distance(name, pn);
      if (nd === 0 && TLD_TYPOS[tld] === pt) { best = p; bestDist = 0; break; }
      if (nd >= 1 && nd <= 2 && nd < bestDist) { best = p; bestDist = nd; }
    }
    if (best) return local + '@' + best;
    return tldFixed ? local + '@' + tldFixed : '';
  }

  function phoneProblem(value) {
    var v = str(value);
    if (!v) return '';
    var msg = 'Enter a valid phone number, like +1 234 567 8900.';
    var main = v.replace(/\s*(?:ext\.?|extension|x)\s*[0-9.]+\s*$/i, '');
    if (/[^\d\s().+\-\/]/.test(main)) return msg;
    return main.replace(/\D/g, '').length >= 7 ? '' : msg;
  }

  function zipProblem(value, lower48Msg) {
    var z = str(value);
    if (!/^\d{5}(-\d{4})?$/.test(z)) return 'Enter a 5-digit ZIP or ZIP+4.';
    var p = parseInt(z.slice(0, 3), 10);
    if ((p >= 995 && p <= 999) || p === 967 || p === 968 || p === 969 || (p >= 6 && p <= 9)) return lower48Msg;
    return '';
  }

  function hasMilitaryMail(s) { return /\b(APO|FPO|DPO)\b/i.test(String(s || '')); }

  /* '' = fine, otherwise the message to show under the field. opts: { states: {NY:1,...}, lower48Msg } */
  function fieldProblem(id, value, opts) {
    var v = str(value);
    var o = opts || {};
    var lower48 = o.lower48Msg || 'We ship to the contiguous US only.';
    if (!v) return REQUIRED[id] ? 'Required' : '';
    switch (id) {
      case 'firstName':
      case 'lastName': return NAME_RE.test(nfc(v)) ? '' : 'Use letters only.';
      case 'email': return emailProblem(v);
      case 'phone': return phoneProblem(v);
      case 'address1':
        if (hasMilitaryMail(v)) return lower48;
        return v.length >= 3 && /[\p{L}\p{N}]/u.test(v) ? '' : 'Enter your street address.';
      case 'address2': return hasMilitaryMail(v) ? lower48 : '';
      case 'city':
        if (hasMilitaryMail(v)) return lower48;
        v = nfc(v);
        return v.length >= 2 && CITY_RE.test(v) && /\p{L}/u.test(v) ? '' : 'Enter a city name.';
      case 'state': return o.states && !o.states[v.toUpperCase()] ? lower48 : '';
      case 'zip': return zipProblem(v, lower48);
      case 'country': return v !== 'US' ? lower48 : '';
    }
    return '';
  }

  /* [{id, msg}] in page order; ids defaults to every field */
  function validateAll(values, opts, ids) {
    var out = [];
    (ids || FIELDS).forEach(function (id) {
      var msg = fieldProblem(id, values ? values[id] : '', opts);
      if (msg) out.push({ id: id, msg: msg });
    });
    return out;
  }

  /* Used when checkout-validate.js itself did not load: empty required fields only. A suggestion is not an error. */
  function basicRequiredProblems(values, ids) {
    var out = [];
    (ids || FIELDS).forEach(function (id) {
      if (!REQUIRED[id]) return;
      if (!str(values ? values[id] : '')) out.push({ id: id, msg: 'Required' });
    });
    return out;
  }

  /* ---- live wiring (browser only) ---- */
  var cfg = null;
  var keptEmails = {};   /* addresses the buyer confirmed as correct despite a suggestion */
  var pointerOnHint = false;

  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value : ''; }
  function showField(id, msg) { if (cfg && cfg.fieldError) cfg.fieldError(id, msg); }

  function pendingSuggestion() {
    var v = str(val('email'));
    if (!v || keptEmails[v.toLowerCase()] || emailProblem(v)) return '';
    return emailSuggestion(v);
  }

  function renderEmailHint() {
    var input = el('email');
    var grp = input && input.closest('.form-group');
    if (!grp) return;
    var hint = grp.querySelector('.blr-email-hint');
    var sug = pendingSuggestion();
    if (!sug) { if (hint) hint.remove(); return; }
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'blr-email-hint';
      hint.setAttribute('role', 'status');
      (grp.querySelector('.err-msg') || input).insertAdjacentElement('afterend', hint);
      /* leaving the pointer on the hint must not let blur wipe the buttons before the click lands */
      var hold = function () { pointerOnHint = true; };
      var release = function () { pointerOnHint = false; };
      hint.addEventListener('pointerenter', hold);
      hint.addEventListener('mouseenter', hold);
      hint.addEventListener('pointerleave', release);
      hint.addEventListener('mouseleave', release);
      hint.addEventListener('pointerup', release);
      hint.addEventListener('mouseup', release);
    }
    /* same suggestion already on screen: do not rebuild, or the click target disappears on blur */
    if (hint.getAttribute('data-sug') === sug && hint.querySelector('button')) return;
    hint.setAttribute('data-sug', sug);
    hint.textContent = '';
    var text = document.createElement('span');
    text.textContent = 'Did you mean ' + sug + '?';
    function guard(btn) {
      var press = function (ev) {
        pointerOnHint = true;
        if (ev && ev.preventDefault) ev.preventDefault();
      };
      btn.addEventListener('mousedown', press);
      btn.addEventListener('pointerdown', function (ev) {
        if (!ev || ev.pointerType !== 'mouse') return;
        press(ev);
      });
    }
    var use = document.createElement('button');
    use.type = 'button';
    use.textContent = 'Yes, fix it';
    guard(use);
    use.addEventListener('click', function () {
      pointerOnHint = false;
      input.value = sug;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      checkField('email');
    });
    var keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = 'No, mine is correct';
    guard(keep);
    keep.addEventListener('click', function () {
      pointerOnHint = false;
      keptEmails[str(input.value).toLowerCase()] = 1;
      checkField('email');
    });
    hint.appendChild(text);
    hint.appendChild(use);
    hint.appendChild(keep);
  }

  /* marks one field; returns its message ('' = fine) */
  function checkField(id) {
    var msg = fieldProblem(id, val(id), cfg);
    showField(id, msg);
    if (id === 'email') renderEmailHint();
    return msg;
  }

  /* marks every field in ids (default: all); returns the ids that need fixing, in page order */
  function checkForm(ids) {
    var bad = [];
    (ids || FIELDS).forEach(function (id) {
      if (!el(id)) return;
      if (checkField(id)) bad.push(id);
    });
    return bad;
  }

  function reveal(id) {
    var e = el(id);
    if (!e) return;
    /* instant jump: a smooth scroll across most of the page left Safari with unpainted (blank) content until the
       next manual scroll. Browsers that do not know 'instant' throw; a plain focus() then brings the field into view. */
    var jumped = false;
    try { (e.closest('.form-group') || e).scrollIntoView({ behavior: 'instant', block: 'center' }); jumped = true; } catch (err) {}
    try { if (jumped) e.focus({ preventScroll: true }); else e.focus(); } catch (err2) {}
  }

  function summary(ids) {
    if (!ids || !ids.length) return '';
    return 'Please check the highlighted fields above: ' + ids.map(function (id) { return LABELS[id] || id; }).join(', ') + '.';
  }

  /* config: { states, lower48Msg, fieldError(id, msg) } */
  function attach(config) {
    cfg = config || {};
    FIELDS.forEach(function (id) {
      var e = el(id);
      if (!e) return;
      var grp = e.closest('.form-group');
      /* leaving a field checks it; an untouched empty field stays quiet until the buyer presses a button */
      e.addEventListener('blur', function () {
        if (id === 'email' && pointerOnHint) return;
        if (str(e.value)) checkField(id);
      });
      e.addEventListener('change', function () { if (str(e.value)) checkField(id); });
      /* while typing, only re-check a field that is already flagged, so the error clears the moment it is fixed */
      e.addEventListener('input', function () {
        if (grp && grp.classList.contains('has-error')) checkField(id);
        else if (id === 'email' && grp && grp.querySelector('.blr-email-hint')) renderEmailHint();
      });
    });
  }

  return {
    FIELDS: FIELDS, CONTACT_FIELDS: CONTACT_FIELDS, LABELS: LABELS,
    fieldProblem: fieldProblem, validateAll: validateAll, emailProblem: emailProblem, emailSuggestion: emailSuggestion,
    basicRequiredProblems: basicRequiredProblems,
    attach: attach, checkField: checkField, checkForm: checkForm, reveal: reveal, summary: summary
  };
});
