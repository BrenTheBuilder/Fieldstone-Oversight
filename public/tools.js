// Turns "Coming soon" buttons into live checkout buttons only when the server reports the product is ready.
(function () {
  var buttons = document.querySelectorAll('[data-buy]');
  if (!buttons.length) return;
  fetch('/api/status', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (status) {
      var any = false;
      buttons.forEach(function (btn) {
        var slug = btn.getAttribute('data-buy');
        if (!status[slug]) return;
        any = true;
        btn.disabled = false; btn.removeAttribute('aria-disabled');
        btn.className = 'btn-quote'; btn.style.cursor = 'pointer'; btn.style.border = '0';
        btn.textContent = 'Buy now';
        btn.addEventListener('click', function () {
          btn.disabled = true; btn.textContent = 'Opening checkout…';
          fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: slug }) })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
              if (res.ok && res.j.url) { window.location.href = res.j.url; return; }
              throw new Error(res.j.error || 'Checkout unavailable');
            })
            .catch(function (e) { btn.disabled = false; btn.textContent = 'Buy now'; alert(e.message); });
        });
      });
      if (any) document.querySelectorAll('[data-soon-note]').forEach(function (el) {
        if (el.classList.contains('notice')) el.hidden = true; else { el.textContent = 'Secure checkout by Stripe. After payment you can download, and a link is emailed to you. By purchasing you agree to the '; var a = document.createElement('a'); a.href = 'terms.html'; a.textContent = 'Purchase Terms'; a.style.color = 'var(--blue-light)'; el.appendChild(a); el.appendChild(document.createTextNode(' (single-company license, 7-day refund).')); }
      });
    })
    .catch(function () { /* stay in "Coming soon" state */ });
  if (/checkout=canceled/.test(location.search)) {
    var n = document.createElement('div'); n.className = 'notice'; n.setAttribute('role', 'status');
    n.textContent = 'Checkout was canceled. You have not been charged.';
    var c = document.querySelector('.container'); if (c) c.insertBefore(n, c.children[1] || null);
  }
})();
