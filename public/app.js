/* OSRSpt frontend.
 * Talks ONLY to our own Express API. No API keys, no database strings,
 * no third-party endpoints are referenced here.
 */
(function () {
  'use strict';

  var el = function (id) {
    return document.getElementById(id);
  };

  var chat = el('chat');
  var composer = el('composer');
  var messageInput = el('messageInput');
  var sendBtn = el('sendBtn');
  var newChatBtn = el('newChatBtn');
  var rsnInput = el('rsnInput');
  var modeSelect = el('modeSelect');
  var styleSelect = el('styleSelect');
  var tierSelect = el('tierSelect');
  var loading = el('loading');
  var loadingText = el('loadingText');
  var errorBox = el('errorBox');
  var charCount = el('charCount');

  var permissionPanel = el('permissionPanel');
  var permissionText = el('permissionText');
  var permissionAllow = el('permissionAllow');
  var permissionDeny = el('permissionDeny');

  var playerCard = el('playerCard');
  var playerName = el('playerName');
  var playerMeta = el('playerMeta');
  var playerSkills = el('playerSkills');
  var refreshPlayer = el('refreshPlayer');

  var statusDot = el('statusDot');
  var statusText = el('statusText');

  var KEY_SESSION = 'osrspt.sessionId';
  var KEY_RSN = 'osrspt.rsn';
  var KEY_MODE = 'osrspt.mode';

  var state = {
    sessionId: null,
    rsn: null,
    mode: 'main',
    permissionGranted: false,
    pendingRsn: null,
    busy: false,
  };

  // ---------- helpers ----------

  function newSessionId() {
    var rand =
      window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID().replace(/-/g, '')
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return ('s-' + rand).slice(0, 60);
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function setBusy(busy, text) {
    state.busy = busy;
    loading.hidden = !busy;
    if (text) loadingText.textContent = text;
    sendBtn.disabled = busy;
    refreshPlayer.disabled = busy;
    permissionAllow.disabled = busy;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Minimal, safe renderer: escape everything first, then allow a few
   * markdown-ish constructs the model commonly emits. */
  function renderText(text) {
    var safe = escapeHtml(text);
    var lines = safe.split(/\r?\n/);
    var html = '';
    var inList = false;

    function closeList() {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    }

    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) {
        closeList();
        return;
      }
      var heading = t.match(/^#{1,6}\s+(.*)$/);
      if (heading) {
        closeList();
        html += '<h4>' + inline(heading[1]) + '</h4>';
        return;
      }
      var bullet = t.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
      if (bullet) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += '<li>' + inline(bullet[1]) + '</li>';
        return;
      }
      closeList();
      html += '<p>' + inline(t) + '</p>';
    });

    closeList();
    return html;
  }

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');
  }

  function addMessage(role, text) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = renderText(text);
    wrap.appendChild(bubble);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return bubble;
  }

  async function api(path, options) {
    var res = await fetch(path, options);
    var data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* non-JSON response */
    }
    if (!res.ok) {
      var msg =
        (data && data.error && data.error.message) ||
        'Request failed (HTTP ' + res.status + ').';
      var err = new Error(msg);
      err.code = data && data.error && data.error.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- health ----------

  async function checkHealth() {
    try {
      var h = await api('/health');
      var problems = [];
      if (h.database !== 'connected') problems.push('database ' + h.database);
      if (h.ai !== 'configured') problems.push('AI not configured');

      if (problems.length === 0) {
        statusDot.className = 'dot ok';
        statusText.textContent = 'online';
      } else {
        statusDot.className = h.ai === 'configured' ? 'dot warn' : 'dot bad';
        statusText.textContent = problems.join(' · ');
      }
    } catch (_) {
      statusDot.className = 'dot bad';
      statusText.textContent = 'server unreachable';
    }
  }

  // ---------- permission flow ----------

  function askPermission(rsn) {
    if (state.busy) return;
    state.pendingRsn = rsn;
    permissionText.innerHTML =
      'May I look up the public OSRS hiscores for <strong>' + escapeHtml(rsn) + '</strong>';
    permissionPanel.hidden = false;
  }

  function hidePermission() {
    permissionPanel.hidden = true;
    state.pendingRsn = null;
  }

  permissionAllow.addEventListener('click', function () {
    var rsn = state.pendingRsn;
    hidePermission();
    if (rsn) lookupPlayer(rsn);
  });

  permissionDeny.addEventListener('click', function () {
    hidePermission();
    state.permissionGranted = false;
    addMessage(
      'assistant',
      "No problem — I won't look up your account. I'll keep advice general. You can tell me your levels directly if you'd like something more specific."
    );
  });

  // ---------- player lookup ----------

  async function lookupPlayer(rsn) {
    clearError();
    setBusy(true, 'Looking up public hiscores for ' + rsn + '…');
    try {
      var data = await api('/api/player/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rsn: rsn,
          mode: modeSelect.value,
          permissionGranted: true,
          sessionId: state.sessionId,
        }),
      });

      state.rsn = data.rsn;
      state.permissionGranted = true;
      state.mode = modeSelect.value;
      localStorage.setItem(KEY_RSN, data.rsn);
      localStorage.setItem(KEY_MODE, state.mode);
      rsnInput.value = data.rsn;

      hidePermission();
      renderPlayer(data.stats);

      if (data.persisted === false) {
        showError(
          'Stats loaded, but the database is unavailable so they will not be remembered between restarts.'
        );
      }
    } catch (err) {
      showError(err.message);
      playerCard.hidden = true;
      state.permissionGranted = false;
    } finally {
      setBusy(false);
    }
  }

  function renderPlayer(stats) {
    playerName.textContent = stats.rsn;
    playerMeta.innerHTML = '';

    var chips = [];
    if (stats.combatLevel != null) chips.push('Combat ' + stats.combatLevel);
    if (stats.totalLevel != null) chips.push('Total ' + stats.totalLevel);
    if (stats.totalXp != null) chips.push('XP ' + Number(stats.totalXp).toLocaleString());
    chips.push(
      'Mode: ' +
        (modeSelect.options[modeSelect.selectedIndex]
          ? modeSelect.options[modeSelect.selectedIndex].text
          : stats.mode)
    );

    chips.forEach(function (c) {
      var span = document.createElement('span');
      span.className = 'chip';
      span.textContent = c;
      playerMeta.appendChild(span);
    });

    playerSkills.innerHTML = '';
    (stats.skills || [])
      .filter(function (s) {
        return s.name.toLowerCase() !== 'overall';
      })
      .forEach(function (s) {
        var row = document.createElement('div');
        row.className = 'skill';
        var n = document.createElement('span');
        n.textContent = s.name;
        var v = document.createElement('span');
        v.textContent = s.unranked ? '—' : s.level;
        row.appendChild(n);
        row.appendChild(v);
        playerSkills.appendChild(row);
      });

    playerCard.hidden = false;
  }

  refreshPlayer.addEventListener('click', function () {
    var rsn = (rsnInput.value || state.rsn || '').trim();
    if (!rsn) {
      showError('Enter an RSN first.');
      return;
    }
    lookupPlayer(rsn);
  });

  // When the user types a new RSN and leaves the field, offer a lookup.
  rsnInput.addEventListener('change', function () {
    var rsn = rsnInput.value.trim();
    if (!rsn) {
      state.rsn = null;
      state.permissionGranted = false;
      playerCard.hidden = true;
      localStorage.removeItem(KEY_RSN);
      hidePermission();
      return;
    }
    if (rsn.toLowerCase() !== String(state.rsn || '').toLowerCase()) {
      state.permissionGranted = false;
      playerCard.hidden = true;
      askPermission(rsn);
    }
  });

  modeSelect.addEventListener('change', function () {
    localStorage.setItem(KEY_MODE, modeSelect.value);
    var rsn = rsnInput.value.trim();
    if (rsn && state.permissionGranted) lookupPlayer(rsn);
  });

  // ---------- chat ----------

  composer.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (state.busy) return;

    var text = messageInput.value.trim();
    if (!text) return;

    clearError();
    addMessage('user', text);
    messageInput.value = '';
    updateCount();

    var rsn = rsnInput.value.trim() || null;
    setBusy(true, 'Thinking…');

    try {
      var data = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          message: text,
          rsn: rsn,
          style: styleSelect.value,
          gearTier: tierSelect.value || null,
          permissionGranted: state.permissionGranted,
        }),
      });

      addMessage('assistant', data.reply);

      // If the server says we have an RSN but no permission, surface the gate.
      if (data.needsPermission && rsn) askPermission(rsn);
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  });

  messageInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  function updateCount() {
    charCount.textContent = messageInput.value.length + ' / 2000';
  }
  messageInput.addEventListener('input', updateCount);

  newChatBtn.addEventListener('click', function () {
    state.sessionId = newSessionId();
    localStorage.setItem(KEY_SESSION, state.sessionId);
    chat.innerHTML = '';
    addMessage('assistant', 'New chat started. What would you like to work on?');
    clearError();
    hidePermission();
  });

  // ---------- history restore ----------

  async function restoreHistory() {
    try {
      var data = await api('/api/chat/' + encodeURIComponent(state.sessionId));
      if (data && data.messages && data.messages.length) {
        chat.innerHTML = '';
        data.messages.forEach(function (m) {
          if (m.role === 'user' || m.role === 'assistant') addMessage(m.role, m.content);
        });
      }
      if (data && data.rsn) {
        state.rsn = data.rsn;
        rsnInput.value = data.rsn;
        if (data.lookupPermissionGranted) {
          state.permissionGranted = true;
          try {
            var p = await api('/api/player/' + encodeURIComponent(data.rsn));
            if (p && p.stats) renderPlayer(p.stats);
          } catch (_) {
            /* nothing cached yet */
          }
        }
      }
    } catch (_) {
      /* no history is fine */
    }
  }

  // ---------- init ----------

  state.sessionId = localStorage.getItem(KEY_SESSION) || newSessionId();
  localStorage.setItem(KEY_SESSION, state.sessionId);

  var savedRsn = localStorage.getItem(KEY_RSN);
  if (savedRsn) rsnInput.value = savedRsn;
  var savedMode = localStorage.getItem(KEY_MODE);
  if (savedMode) modeSelect.value = savedMode;

  updateCount();
  checkHealth();
  restoreHistory();
})();
