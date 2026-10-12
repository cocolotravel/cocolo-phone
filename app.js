(function () {
  'use strict';

  // Where the n8n endpoints live. No secrets are stored in this file.
  var API = 'https://n8n.cocolotravel.com/webhook';
  var STORAGE_KEY = 'cocolo-call-auth';
  var E164 = /^\+[1-9][0-9]{6,14}$/;

  var params = new URLSearchParams(window.location.search);
  var ticket = (params.get('ticket') || '').trim();

  function $(id) { return document.getElementById(id); }

  var els = {
    login: $('login'), user: $('user'), pass: $('pass'), signin: $('signin'), loginError: $('login-error'),
    ticketSection: $('ticket'), ticketLine: $('ticket-line'), customerName: $('customer-name'), ticketTitle: $('ticket-title'),
    phoneList: $('phone-list'), manual: $('manual'), numberHint: $('number-hint'),
    norecord: $('norecord'), call: $('call'), status: $('status'),
    inCall: $('in-call'), timer: $('timer'), mute: $('mute'), hangup: $('hangup'),
    fatal: $('fatal')
  };

  var authHeader = null;
  var info = null;
  var device = null;
  var activeCall = null;
  var timerHandle = null;
  var callStartedAt = 0;
  var callWasRecorded = false;

  // ---------- helpers ----------

  function basic(user, pass) {
    var bytes = new TextEncoder().encode(user + ':' + pass);
    var bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return 'Basic ' + btoa(bin);
  }

  function api(path) {
    return fetch(API + path, { headers: { Authorization: authHeader }, cache: 'no-store' }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        var authError = new Error('Wrong username or password');
        authError.code = 'auth';
        throw authError;
      }
      if (!res.ok) { throw new Error('The server answered with an error (' + res.status + ')'); }
      return res.json();
    });
  }

  function tidyNumber(value) {
    var s = String(value || '').split('').filter(function (c) { return '+0123456789'.indexOf(c) !== -1; }).join('');
    if (s.indexOf('00') === 0) { s = '+' + s.slice(2); }
    return s;
  }

  function setStatus(text, isError) {
    els.status.textContent = text || '';
    els.status.className = isError ? 'status error' : 'status';
  }

  function show(el, visible) { el.hidden = !visible; }

  function formatTime(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---------- sign in and load the ticket ----------

  function showLogin(message) {
    show(els.ticketSection, false);
    show(els.login, true);
    if (message) {
      els.loginError.textContent = message;
      show(els.loginError, true);
    } else {
      show(els.loginError, false);
    }
  }

  function loadTicket() {
    return api('/softphone-ticket?ticket=' + encodeURIComponent(ticket)).then(function (data) {
      info = data;
      sessionStorage.setItem(STORAGE_KEY, authHeader);
      renderTicket();
    });
  }

  function handleLoadError(err) {
    if (err && err.code === 'auth') {
      sessionStorage.removeItem(STORAGE_KEY);
      authHeader = null;
      showLogin('Wrong username or password.');
      return;
    }
    show(els.login, false);
    show(els.ticketSection, false);
    els.fatal.textContent = (err instanceof TypeError)
      ? 'Could not reach the server. Check your connection and try again.'
      : 'This ticket could not be loaded. Check that it exists and is in the Sales group.';
    show(els.fatal, true);
  }

  function renderTicket() {
    show(els.login, false);
    show(els.fatal, false);
    show(els.ticketSection, true);

    var stage = info.salesStage ? ' - ' + info.salesStage : '';
    els.ticketLine.textContent = 'Ticket #' + info.ticketNumber + stage;
    els.customerName.textContent = info.customerName;
    els.ticketTitle.textContent = info.title || '';

    els.phoneList.textContent = '';
    var preselected = false;
    (info.phones || []).forEach(function (p, index) {
      var label = document.createElement('label');
      label.className = 'phone-option';

      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'phone';
      radio.value = p.number;
      radio.id = 'phone-' + index;
      radio.disabled = !p.international;
      if (p.international && !preselected) { radio.checked = true; preselected = true; }

      var text = document.createElement('span');
      text.textContent = p.label + ': ' + p.stored;
      if (!p.international) {
        var note = document.createElement('small');
        note.textContent = 'No country code stored. Type the full number in the box below.';
        text.appendChild(note);
      }

      label.appendChild(radio);
      label.appendChild(text);
      els.phoneList.appendChild(label);
    });

    if (!(info.phones || []).length) {
      var none = document.createElement('p');
      none.className = 'hint';
      none.textContent = 'No phone number is stored for this customer. Type one below.';
      els.phoneList.appendChild(none);
    }
  }

  // ---------- choosing the number ----------

  function chosenNumber() {
    var typed = tidyNumber(els.manual.value);
    if (typed) { return typed; }
    var checked = document.querySelector('input[name="phone"]:checked');
    return checked ? checked.value : '';
  }

  els.manual.addEventListener('input', function () {
    var typed = tidyNumber(els.manual.value);
    if (typed && !E164.test(typed)) {
      els.numberHint.textContent = 'Use the international format, starting with + and the country code.';
      show(els.numberHint, true);
    } else {
      show(els.numberHint, false);
    }
  });

  // ---------- placing the call ----------

  function endCallUi(message, isError) {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    activeCall = null;
    if (device) {
      try { device.destroy(); } catch (e) { /* already gone */ }
      device = null;
    }
    show(els.inCall, false);
    els.call.disabled = false;
    els.manual.disabled = false;
    els.norecord.disabled = false;
    els.mute.textContent = 'Mute';
    setStatus(message, isError);
  }

  function wireCall(call) {
    activeCall = call;

    call.on('ringing', function () { setStatus('Ringing...'); });

    call.on('accept', function () {
      setStatus(callWasRecorded ? 'Connected. The customer hears the recording notice first.' : 'Connected (not recorded).');
      show(els.inCall, true);
      callStartedAt = Date.now();
      els.timer.textContent = '00:00';
      timerHandle = setInterval(function () {
        els.timer.textContent = formatTime(Math.floor((Date.now() - callStartedAt) / 1000));
      }, 1000);
    });

    call.on('mute', function (isMuted) { els.mute.textContent = isMuted ? 'Unmute' : 'Mute'; });

    call.on('disconnect', function () {
      endCallUi(callWasRecorded
        ? 'Call ended. A note with the transcript and summary will appear on ticket #' + info.ticketNumber + ' in a few minutes.'
        : 'Call ended (not recorded).');
    });

    call.on('cancel', function () { endCallUi('Call cancelled.'); });
    call.on('reject', function () { endCallUi('The call was rejected.', true); });
    call.on('error', function (err) {
      endCallUi('Call error: ' + (err && err.message ? err.message : 'unknown') + (err && err.code ? ' (code ' + err.code + ')' : ''), true);
    });
  }

  function startCall() {
    var number = chosenNumber();
    if (!E164.test(number)) {
      setStatus('Choose a number, or type one in international format (+ and the country code).', true);
      return;
    }

    var norecord = els.norecord.checked;
    var question = 'Call ' + info.customerName + ' on ' + number + (norecord ? ' (NOT recorded)' : '') + '?';
    if (!window.confirm(question)) { return; }

    callWasRecorded = !norecord;
    els.call.disabled = true;
    els.manual.disabled = true;
    els.norecord.disabled = true;
    setStatus('Checking the microphone...');

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        setStatus('Getting ready...');
        return api('/softphone-token');
      })
      .then(function (data) {
        device = new Twilio.Device(data.token, { codecPreferences: ['opus', 'pcmu'], closeProtection: true, logLevel: 'error' });

        device.on('error', function (err) {
          endCallUi('Phone error: ' + (err && err.message ? err.message : 'unknown') + (err && err.code ? ' (code ' + err.code + ')' : ''), true);
        });
        device.on('tokenWillExpire', function () {
          api('/softphone-token').then(function (fresh) { device.updateToken(fresh.token); });
        });

        setStatus('Calling...');
        return device.connect({ params: { To: number, ticket: ticket, norecord: norecord ? '1' : '0' } });
      })
      .then(function (call) { wireCall(call); })
      .catch(function (err) {
        var message = 'The call could not start.';
        if (err && err.name === 'NotAllowedError') {
          message = 'The microphone is blocked. Allow it in the browser address bar, then try again.';
        } else if (err && err.code === 'auth') {
          message = 'Your session has expired. Reload the page and sign in again.';
        } else if (err && err.message) {
          message = 'The call could not start: ' + err.message;
        }
        endCallUi(message, true);
      });
  }

  els.call.addEventListener('click', startCall);
  els.hangup.addEventListener('click', function () { if (activeCall) { activeCall.disconnect(); } });
  els.mute.addEventListener('click', function () { if (activeCall) { activeCall.mute(!activeCall.isMuted()); } });

  // ---------- start ----------

  els.signin.addEventListener('click', function () {
    var user = els.user.value.trim();
    var pass = els.pass.value;
    if (!user || !pass) { showLogin('Enter the username and password.'); return; }
    authHeader = basic(user, pass);
    els.pass.value = '';
    loadTicket().catch(handleLoadError);
  });
  els.pass.addEventListener('keydown', function (event) { if (event.key === 'Enter') { els.signin.click(); } });

  if (!/^[0-9]{3,12}$/.test(ticket)) {
    els.fatal.textContent = 'Open this page from the "Call customer" link on a Zammad ticket.';
    show(els.fatal, true);
    return;
  }

  authHeader = sessionStorage.getItem(STORAGE_KEY);
  if (authHeader) {
    loadTicket().catch(handleLoadError);
  } else {
    showLogin('');
  }
}());
