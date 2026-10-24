// "No access yet" page. Asks the router's /userinfo who is signed in:
//   403 access_not_granted -> "signed in as <name> (<email>)" and a mailto
//                             that carries their e-mail;
//   200 authenticated      -> they do have access after all: go home;
//   anything else          -> keep the generic page.
// Values are written as text only, never as HTML.
(function () {
  'use strict';

  var CONTACT = 'markus@lintuala.fi';
  var SUBJECT = 'Access request to figureskatingtools.com';
  function body(email) {
    return 'Hello,\n\nI would like access to figureskatingtools.com.\n\n' +
      'I signed in with: ' + email + '\n';
  }

  function mailto(email) {
    var href = 'mailto:' + CONTACT + '?subject=' + encodeURIComponent(SUBJECT);
    if (email) href += '&body=' + encodeURIComponent(body(email));
    return href;
  }

  function showDenied(name, email) {
    var who = name && email ? name + ' (' + email + ')' : name || email;
    if (who) {
      document.querySelectorAll('[data-field="who"]').forEach(function (el) {
        el.textContent = who;
      });
      document.querySelectorAll('.signed-in').forEach(function (el) {
        el.hidden = false;
      });
    }
    document.querySelectorAll('[data-mailto]').forEach(function (el) {
      el.setAttribute('href', mailto(email));
    });
    document.documentElement.classList.add('is-denied');
  }

  function asText(value) {
    return typeof value === 'string' ? value.trim().slice(0, 200) : '';
  }

  function run() {
    // redirect: 'manual' — signed out, Easy Auth answers with a 302 to the
    // sign-in page; following it would only trip the CSP. Opaque = generic.
    fetch('/userinfo', { headers: { Accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual' })
      .then(function (resp) {
        return resp.json().then(
          function (body) { return { status: resp.status, body: body }; },
          function () { return { status: resp.status, body: null }; }
        );
      })
      .then(function (r) {
        if (r.status === 403 && r.body && r.body.error === 'access_not_granted') {
          showDenied(asText(r.body.name), asText(r.body.email));
        } else if (r.status === 200 && r.body && r.body.authenticated === true) {
          window.location.replace('/');
        }
      })
      .catch(function () { /* generic page */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
