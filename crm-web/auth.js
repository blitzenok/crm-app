/**
 * BioLabs Research CRM - shared auth gate.
 * Loaded by every CRM page via <script src="auth.js"></script> before page-specific scripts.
 * Phase 0 (2026-09-04): the session is validated on the server (GET /api/session). No user list,
 * no password and no role decisions live in the client any more; a 401 clears the session and
 * sends the browser to the login page.
 */

// Pages restricted to admins only
const ADMIN_ONLY_PAGES = ['users.html']; // phase 2 (2026-09-05): users.html added; phase 7 (2026-09-06, EQUAL_RIGHTS_UI): store-settings.html opens for every signed-in user, the menu item is no longer admin-only either (crm.js NAV)

(function() {
    // Telegram alerts (2026-09-30): the page asked for is remembered for this tab, so login.html can come back to it (an alert
    // links to orders.html#q=<order>; before this a sign-in always landed on the dashboard). Every redirect to the login page
    // (here, a page's own check, crm.js on a 401) happens after this line has run.
    try { sessionStorage.setItem('crm_return_to', window.location.pathname + window.location.hash); } catch (e) { /* storage off: the dashboard, as before */ }
    const token = localStorage.getItem('crm_token');

    function toLogin() {
        localStorage.removeItem('crm_token');
        localStorage.removeItem('crm_user');
        window.location.href = '/crm/login.html';
    }

    if (!token) {
        toLogin();
        return;
    }

    function initialsOf(name, email) {
        const base = String(name || email || '').trim();
        const parts = base.split(/\s+/).filter(Boolean);
        const init = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : base.slice(0, 2);
        return init.toUpperCase();
    }

    function applyUser(user) {
        // Admin-only page check
        const currentPage = window.location.pathname.split('/').pop();
        if (ADMIN_ONLY_PAGES.includes(currentPage) && user.role !== 'admin') {
            alert('Admin access required. Redirecting to dashboard.');
            window.location.href = '/crm/dashboard.html';
            return;
        }
        window.CRM_CURRENT_USER = user;
        function decorate() {
            // Hide admin-only nav items for regular users
            if (user.role !== 'admin') {
                document.querySelectorAll('[data-admin-only]').forEach(function(el) {
                    el.style.display = 'none';
                });
            }
            // Update any user display name
            document.querySelectorAll('[id="user-name"], [id="topbar-user"], .user-initials').forEach(function(el) {
                if (el && user.initials) el.textContent = user.initials;
            });
            // Phase 2 (2026-09-05): the initials/avatar element in the topbar shows the signed-in user and opens My Account.
            // Pages without such an element are left alone (the sidebar has a "My Account" item too).
            document.querySelectorAll('.topbar .avatar, [id="user-name"], [id="topbar-user"], .user-initials').forEach(function(el) {
                if (!el || el.closest('a') || el.getAttribute('data-account-link') === '1') return;
                if (user.initials) el.textContent = user.initials;
                el.setAttribute('data-account-link', '1');
                el.setAttribute('role', 'link');
                el.title = (user.name || user.email || '') + ' \u2014 My Account';
                el.style.cursor = 'pointer';
                el.addEventListener('click', function() { window.location.href = '/crm/account.html'; });
            });
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorate);
        else decorate();
    }

    // Cached identity from the last successful login / session check, so page scripts that read
    // window.CRM_CURRENT_USER synchronously keep working; the server answer below replaces it.
    let cached = {};
    try { cached = JSON.parse(localStorage.getItem('crm_user')) || {}; } catch (e) {}
    // Phase 5 (2026-09-05): the server speaks one role vocabulary now — 'admin' | 'staff' (a legacy 'user' in
    // users.json arrives as 'staff'). Pages compare with 'admin' only, so nothing else changes.
    cached.role = cached.role === 'admin' ? 'admin' : 'staff';
    cached.initials = initialsOf(cached.name, cached.email);
    window.CRM_CURRENT_USER = cached;

    fetch('/api/session', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(r) {
            if (r.status === 401) { toLogin(); return null; }
            if (!r.ok) throw new Error('session check failed: HTTP ' + r.status);
            return r.json();
        })
        .then(function(data) {
            if (!data) return;
            const u = data.user || {};
            const user = {
                email: String(u.email || cached.email || '').toLowerCase(),
                name: u.name || u.email || '',
                role: u.role === 'admin' ? 'admin' : 'staff'
            };
            user.initials = initialsOf(user.name, user.email);
            localStorage.setItem('crm_user', JSON.stringify(user));
            applyUser(user);
        })
        .catch(function(err) {
            // Server unreachable or 5xx: keep the cached name for this page load, but never the cached role —
            // admin-only elements stay hidden until the server confirms the session (phase 1, 2026-09-04).
            console.error('[auth] ' + err.message);
            applyUser(Object.assign({}, cached, { role: 'staff' }));
        });
})();
