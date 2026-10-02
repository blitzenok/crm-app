/* Transport of the CRM blog pages. Not crm.js api(): that one sends a 401 to the login page (the author would lose the
   open article) and reduces an error to its message (a 409 must keep `current`: who saved and when). Here:
   - every non-2xx answer rejects with an Error that has .status, .code (the server's `error`) and .body (the whole JSON);
   - a 401 emits the "auth" event and nothing else: the page shows "Session expired" and keeps the text;
   - a dead network rejects with status 0 and network:true;
   - upload() sends the File itself as the raw body (XMLHttpRequest, for progress) and can be aborted through a signal. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BlogApi = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function createBlogApi(opts) {
    opts = opts || {};
    var base = opts.base || '/blog-desk/';
    var getToken = opts.getToken || function () { return ''; };
    var listeners = {};

    function on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      return function () { listeners[event] = (listeners[event] || []).filter(function (f) { return f !== cb; }); };
    }
    function emit(event, arg) {
      (listeners[event] || []).slice().forEach(function (cb) { try { cb(arg); } catch (e) { /* a listener must not break the request */ } });
    }

    function url(path) { return base + String(path).replace(/^\/+/, ''); }

    function httpError(status, text) {
      var body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
      var msg = body && typeof body.message === 'string' && body.message ? body.message : 'HTTP ' + status;
      var err = new Error(msg);
      err.status = status;
      err.body = body;
      err.code = body && typeof body.error === 'string' ? body.error : '';
      if (status === 401) emit('auth', err);
      return err;
    }
    function networkError(cause) {
      var err = new Error('Network error');
      err.status = 0;
      err.network = true;
      err.body = null;
      err.code = '';
      err.cause = cause;
      return err;
    }
    function parse(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (e) { return null; }
    }

    async function request(method, path, body) {
      var headers = { Authorization: 'Bearer ' + getToken() };
      var init = { method: method, headers: headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      var res;
      var text;
      try {
        res = await (opts.fetch || fetch)(url(path), init);
        text = await res.text();
      } catch (e) {
        throw networkError(e);
      }
      if (!res.ok) throw httpError(res.status, text);
      return parse(text);
    }

    function abortError() {
      var err = new Error('Upload cancelled');
      err.name = 'AbortError';
      return err;
    }

    function upload(path, file, o) {
      o = o || {};
      return new Promise(function (resolve, reject) {
        if (o.signal && o.signal.aborted) { reject(abortError()); return; }
        var Xhr = opts.XMLHttpRequest || XMLHttpRequest;
        var xhr = new Xhr();
        xhr.open('POST', url(path));
        xhr.setRequestHeader('Authorization', 'Bearer ' + getToken());
        xhr.setRequestHeader('Content-Type', (file && file.type) || 'application/octet-stream');
        var extra = o.headers || {};
        Object.keys(extra).forEach(function (k) { xhr.setRequestHeader(k, extra[k]); });
        if (xhr.upload && typeof o.onProgress === 'function') {
          xhr.upload.onprogress = function (e) { if (e && e.lengthComputable && e.total) o.onProgress(e.loaded / e.total); };
        }
        var onAbort = null;
        function done() { if (o.signal && onAbort) o.signal.removeEventListener('abort', onAbort); }
        xhr.onload = function () {
          done();
          if (xhr.status >= 200 && xhr.status < 300) resolve(parse(xhr.responseText));
          else reject(httpError(xhr.status, xhr.responseText));
        };
        xhr.onerror = function () { done(); reject(networkError(null)); };
        xhr.ontimeout = xhr.onerror;
        xhr.onabort = function () { done(); reject(abortError()); };
        if (o.signal) {
          onAbort = function () { xhr.abort(); };
          o.signal.addEventListener('abort', onAbort);
        }
        xhr.send(file);
      });
    }

    return {
      get: function (path) { return request('GET', path); },
      send: function (method, path, body) { return request(method, path, body === undefined ? {} : body); },
      upload: upload,
      on: on,
    };
  }

  return { createBlogApi: createBlogApi };
}));
