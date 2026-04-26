/* ══════════════════════════════════════════
   Betty — shared AI chat widget
   Self-mounts on load. Works in any app that
   has /api/chat + /api/tts endpoints available
   on the same origin.
   ══════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Config (override via window.BETTY_CONFIG before loading this script) ─
  const CFG = Object.assign({
    apiBase: '',                  // '' = same origin; '/api/chat' and '/api/tts' will be appended
    intro: "Hey — I'm Betty, your BV dashboard assistant.<br>I have live access to Airtable (tasks, supply, crew schedule, Amazon orders, projects). Ask me anything — by voice or text. Try one of these:",
    examples: [
      "Who's working in the shop today?",
      "How many days is Dylan working this week?",
      "Who hasn't been confirmed for this week yet?",
      "Who's tentative for Friday's setup but still needs confirmation?",
      "Who's off this Friday?",
      "What supply items are still waiting to arrive?",
      "Which Amazon orders shipped this week?",
      "List active projects without a QB code.",
      "What's the status of the Sequoia Gold Gala neon signs?",
      "Which tasks are overdue?",
      "Show me every project with a final render uploaded.",
    ],
    placeholder: 'Ask about tasks, supply, crew…',
  }, window.BETTY_CONFIG || {});

  const MIC_SVG  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
  const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  // ── Inject DOM ───────────────────────────────────────────────────────────
  function mount() {
    if (document.getElementById('chat-fab')) return; // already mounted

    const fab = document.createElement('button');
    fab.id = 'chat-fab';
    fab.setAttribute('aria-label', 'Open AI chat');
    fab.innerHTML = MIC_SVG + ' Ask Betty';
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Betty Assistant');
    panel.innerHTML =
      '<div id="chat-head">'
      +   '<div style="display:flex; gap:8px; align-items:center;">'
      +     '<button id="chat-auth-btn" title="Sign in with your PIN">'
      +       '<span class="dot"></span><span class="label">Sign in</span>'
      +     '</button>'
      +     '<h3>Ask <em>Betty</em></h3>'
      +   '</div>'
      +   '<div style="display:flex; gap:4px; align-items:center;">'
      +     '<button id="chat-voice-toggle" aria-label="Toggle voice" title="Toggle voice replies">🔊</button>'
      +     '<button id="chat-close" aria-label="Close">×</button>'
      +   '</div>'
      + '</div>'
      + '<div id="chat-log"></div>'
      + '<div id="chat-input-row">'
      +   '<button class="chat-btn mic" id="chat-mic" aria-label="Dictate">' + MIC_SVG + '</button>'
      +   '<textarea id="chat-input" rows="1" placeholder="' + CFG.placeholder.replace(/"/g, '&quot;') + '"></textarea>'
      +   '<button class="chat-btn send" id="chat-send" aria-label="Send">' + SEND_SVG + '</button>'
      + '</div>'
      + '<div id="chat-pin-overlay">'
      +   '<h4>Enter PIN</h4>'
      +   '<div class="chat-pin-dots">'
      +     '<div class="chat-pin-dot"></div><div class="chat-pin-dot"></div>'
      +     '<div class="chat-pin-dot"></div><div class="chat-pin-dot"></div>'
      +   '</div>'
      +   '<div class="chat-pin-err"></div>'
      +   '<div class="chat-pin-pad">'
      +     '<button class="chat-pin-btn" data-k="1">1</button>'
      +     '<button class="chat-pin-btn" data-k="2">2</button>'
      +     '<button class="chat-pin-btn" data-k="3">3</button>'
      +     '<button class="chat-pin-btn" data-k="4">4</button>'
      +     '<button class="chat-pin-btn" data-k="5">5</button>'
      +     '<button class="chat-pin-btn" data-k="6">6</button>'
      +     '<button class="chat-pin-btn" data-k="7">7</button>'
      +     '<button class="chat-pin-btn" data-k="8">8</button>'
      +     '<button class="chat-pin-btn" data-k="9">9</button>'
      +     '<button class="chat-pin-btn empty"></button>'
      +     '<button class="chat-pin-btn" data-k="0">0</button>'
      +     '<button class="chat-pin-btn" data-k="del">⌫</button>'
      +   '</div>'
      +   '<button class="chat-pin-cancel">Cancel</button>'
      + '</div>';
    document.body.appendChild(panel);

    wire(fab, panel);
  }

  function wire(fab, panel) {
    const close = panel.querySelector('#chat-close');
    const log   = panel.querySelector('#chat-log');
    const input = panel.querySelector('#chat-input');
    const send  = panel.querySelector('#chat-send');
    const mic   = panel.querySelector('#chat-mic');
    const voiceBtn = panel.querySelector('#chat-voice-toggle');
    const authBtn  = panel.querySelector('#chat-auth-btn');
    const authLbl  = authBtn.querySelector('.label');
    const pinOverlay = panel.querySelector('#chat-pin-overlay');
    const pinDots    = pinOverlay.querySelectorAll('.chat-pin-dot');
    const pinErr     = pinOverlay.querySelector('.chat-pin-err');
    const pinPad     = pinOverlay.querySelector('.chat-pin-pad');
    const pinCancel  = pinOverlay.querySelector('.chat-pin-cancel');

    const history = [];
    let introShown = false;
    let lastInputWasVoice = false;

    // ── Auth ───────────────────────────────────────────────────────────────
    let csToken = localStorage.getItem('cs_token') || '';
    let csRole  = localStorage.getItem('cs_role')  || '';
    let pinBuf  = '';
    let pinCb   = null; // optional callback after successful sign-in

    function updateAuthBtn() {
      authBtn.classList.remove('admin', 'crew');
      if (csRole === 'admin') {
        authBtn.classList.add('admin');
        authLbl.textContent = 'Admin';
        authBtn.title = 'Signed in as Admin — click to sign out';
      } else if (csRole === 'crew') {
        authBtn.classList.add('crew');
        authLbl.textContent = 'Crew';
        authBtn.title = 'Signed in as Crew — click to sign out';
      } else {
        authLbl.textContent = 'Sign in';
        authBtn.title = 'Sign in with your PIN';
      }
    }
    updateAuthBtn();

    function renderPinDots() {
      pinDots.forEach((d, i) => d.classList.toggle('filled', i < pinBuf.length));
    }
    function resetPin(err) {
      pinBuf = '';
      renderPinDots();
      pinErr.textContent = err || '';
    }
    function openPinPad(cb) {
      pinCb = cb || null;
      resetPin('');
      pinOverlay.classList.add('open');
    }
    function closePinPad() {
      pinOverlay.classList.remove('open');
      pinCb = null;
    }

    async function submitPin() {
      try {
        const r = await fetch(CFG.apiBase + '/api/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pin: pinBuf }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.token) {
          resetPin(data.error || 'Invalid PIN');
          return;
        }
        csToken = data.token;
        csRole  = data.role || '';
        localStorage.setItem('cs_token', csToken);
        localStorage.setItem('cs_role',  csRole);
        updateAuthBtn();
        closePinPad();
        const cb = pinCb; pinCb = null;
        if (cb) cb();
      } catch (e) {
        resetPin('Network error');
      }
    }

    pinPad.addEventListener('click', (e) => {
      const btn = e.target.closest('.chat-pin-btn');
      if (!btn) return;
      const k = btn.dataset.k;
      if (!k) return;
      if (k === 'del') {
        pinBuf = pinBuf.slice(0, -1);
        pinErr.textContent = '';
        renderPinDots();
      } else if (pinBuf.length < 4) {
        pinBuf += k;
        pinErr.textContent = '';
        renderPinDots();
        if (pinBuf.length === 4) submitPin();
      }
    });
    pinCancel.addEventListener('click', closePinPad);

    authBtn.addEventListener('click', () => {
      if (csToken) {
        // Sign out
        csToken = ''; csRole = '';
        localStorage.removeItem('cs_token');
        localStorage.removeItem('cs_role');
        updateAuthBtn();
      } else {
        openPinPad();
      }
    });

    function authHeaders() {
      return csToken ? { Authorization: 'Bearer ' + csToken } : {};
    }
    function noop() {}
    function clientTZ() {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
    }

    // Track a currently-displayed confirmation chip so voice/text follow-ups
    // like "yes" / "cancel" can resolve it instead of being sent as a new question.
    let pendingChip = null;
    const YES_RE = /^\s*(yes|yeah|yep|yup|sure|ok|okay|confirm(ed)?|do it|go ahead|affirmative|please do|proceed)\b[.!?\s]*$/i;
    const NO_RE  = /^\s*(no|nope|cancel|nevermind|never\s*mind|stop|don'?t|forget it|abort|negative)\b[.!?\s]*$/i;

    // ── TTS (ElevenLabs via /api/tts) ──────────────────────────────────────
    let voiceOn = localStorage.getItem('bettyVoiceOn') !== '0';
    const audioEl = new Audio();
    audioEl.preload = 'auto';
    let currentAudioUrl = null;
    let audioUnlocked = false;

    // iOS blocks programmatic audio.play() unless the element has been
    // played at least once inside a user gesture. Call this from any tap
    // handler to unlock; subsequent speak() calls then work from anywhere.
    const SILENT_MP3 = 'data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP/7kGQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
    function unlockAudio() {
      if (audioUnlocked) return;
      audioUnlocked = true;
      try {
        audioEl.src = SILENT_MP3;
        const p = audioEl.play();
        if (p && p.then) p.then(() => audioEl.pause()).catch(() => {});
      } catch (_) {}
    }

    function updateVoiceBtn() {
      voiceBtn.textContent = voiceOn ? '🔊' : '🔇';
      voiceBtn.classList.toggle('off', !voiceOn);
    }
    updateVoiceBtn();

    voiceBtn.addEventListener('click', () => {
      voiceOn = !voiceOn;
      localStorage.setItem('bettyVoiceOn', voiceOn ? '1' : '0');
      updateVoiceBtn();
      if (!voiceOn) stopAudio();
    });

    function stopAudio() {
      try { audioEl.pause(); audioEl.currentTime = 0; } catch (_) {}
      if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
      ttsPlaying = false;
    }

    let ttsPlaying = false;

    async function speak(text, onEnd) {
      if (!voiceOn || !text) { onEnd && onEnd(); return; }
      stopAudio();
      try {
        const r = await fetch(CFG.apiBase + '/api/tts', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ text }),
        });
        if (!r.ok) { onEnd && onEnd(); return; }
        const blob = await r.blob();
        currentAudioUrl = URL.createObjectURL(blob);
        audioEl.src = currentAudioUrl;
        audioEl.onplay   = () => { ttsPlaying = true;  if (session) suppressSession(); };
        audioEl.onended  = () => { stopAudio(); if (session) resumeSession(); onEnd && onEnd(); };
        audioEl.onerror  = () => { stopAudio(); if (session) resumeSession(); onEnd && onEnd(); };
        await audioEl.play().catch(() => { onEnd && onEnd(); });
      } catch (_) {
        onEnd && onEnd();
      }
    }

    // ── Chat DOM helpers ───────────────────────────────────────────────────
    function renderIntro() {
      if (introShown) return;
      introShown = true;
      const div = document.createElement('div');
      div.className = 'chat-msg bot intro';
      // CFG.intro is trusted HTML supplied by the host page. Wrap the first
      // line in <strong> up to the first <br>.
      const m = CFG.intro.match(/^(.*?)(<br\s*\/?>)(.*)$/i);
      div.innerHTML = m
        ? '<strong>' + m[1] + '</strong>' + m[2] + m[3]
        : '<strong>' + CFG.intro + '</strong>';
      CFG.examples.forEach(q => {
        const b = document.createElement('button');
        b.className = 'chat-example';
        b.textContent = q;
        b.onclick = () => { input.value = q; submit(); };
        div.appendChild(b);
      });
      log.appendChild(div);
    }

    function addMsg(role, text) {
      const el = document.createElement('div');
      el.className = 'chat-msg ' + (role === 'user' ? 'user' : 'bot');
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    function renderConfirmChip(pending, wasVoice) {
      const chip = document.createElement('div');
      chip.className = 'chat-confirm';
      chip.innerHTML =
          '<div class="summary">' + escapeHtml(pending.summary) + '</div>'
        + '<div class="btns">'
        +   '<button class="ok">Confirm</button>'
        +   '<button class="no">Cancel</button>'
        + '</div>';
      log.appendChild(chip);
      log.scrollTop = log.scrollHeight;

      const ok = chip.querySelector('button.ok');
      const no = chip.querySelector('button.no');
      let resolved = false;

      async function finish(action, viaVoice) {
        if (resolved) return;
        resolved = true;
        if (pendingChip === api) pendingChip = null;
        chip.classList.add('resolved');
        const typingEl = showTyping();
        try {
          const resp = await fetch(CFG.apiBase + '/api/chat', {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
            body: JSON.stringify(action === 'confirm'
              ? { confirm: { name: pending.name, input: pending.input }, tz: clientTZ() }
              : { cancel: true, tz: clientTZ() }),
          });
          const data = await resp.json().catch(() => ({}));
          typingEl.remove();
          const resultText = (data.text || (action === 'confirm' ? 'Done.' : 'Cancelled.')).trim();
          const resultEl = document.createElement('div');
          resultEl.className = 'result';
          resultEl.textContent = resultText;
          chip.appendChild(resultEl);
          log.scrollTop = log.scrollHeight;
          history.push({ role: 'user',      content: action === 'confirm' ? 'Confirmed.' : 'Cancelled.' });
          history.push({ role: 'assistant', content: resultText });

          // Follow-up pending action (e.g. post-crew-change Slack offer).
          if (data.pending) {
            // Speak the short result first, then render the new chip. The chip
            // itself handles voice-listening for yes/no.
            if (viaVoice) {
              speak(resultText, () => renderConfirmChip(data.pending, true));
            } else {
              renderConfirmChip(data.pending, false);
            }
          } else if (viaVoice) {
            speak(resultText, noop);
          }
        } catch (e) {
          typingEl.textContent = 'Error: ' + e.message;
        }
      }

      // Public interface so submit()'s yes/no interception can drive it.
      const api = {
        confirm: (viaVoice) => finish('confirm', viaVoice),
        cancel:  (viaVoice) => finish('cancel',  viaVoice),
        dismiss: () => {
          if (resolved) return;
          resolved = true;
          if (pendingChip === api) pendingChip = null;
          chip.classList.add('resolved');
        },
      };
      pendingChip = api;

      ok.addEventListener('click', () => finish('confirm', false));
      no.addEventListener('click', () => finish('cancel',  false));

      // Voice mode: speak the question, then auto-listen for yes/no.
      if (wasVoice) speak(pending.summary, noop);
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function showTyping() {
      const el = document.createElement('div');
      el.className = 'chat-msg bot';
      el.innerHTML = '<span class="chat-typing"><span></span><span></span><span></span></span>';
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    async function submit() {
      const text = input.value.trim();
      if (!text) return;
      stopAudio();
      const wasVoice = lastInputWasVoice;
      lastInputWasVoice = false;
      input.value = '';
      input.style.height = 'auto';

      // If a confirmation chip is waiting, a yes/no answer resolves it
      // instead of being sent to Betty as a new question.
      if (pendingChip) {
        if (YES_RE.test(text)) { addMsg('user', text); pendingChip.confirm(wasVoice); return; }
        if (NO_RE.test(text))  { addMsg('user', text); pendingChip.cancel(wasVoice);  return; }
        // Not a yes/no — dismiss the chip as stale and proceed with the new question.
        pendingChip.dismiss();
      }

      addMsg('user', text);
      history.push({ role: 'user', content: text });

      const typingEl = showTyping();
      try {
        const resp = await fetch(CFG.apiBase + '/api/chat', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ messages: history, tz: clientTZ() }),
        });
        const data = await resp.json().catch(() => ({}));
        typingEl.remove();
        if (!resp.ok) {
          addMsg('bot', 'Error: ' + (data.error || resp.status));
          return;
        }
        const replyText = (data.text || '').trim();
        if (replyText) {
          addMsg('bot', replyText);
          history.push({ role: 'assistant', content: replyText });
        }
        if (data.pending) {
          renderConfirmChip(data.pending, wasVoice);
        } else if (replyText && wasVoice) {
          speak(replyText, noop);
        }
      } catch (e) {
        typingEl.textContent = 'Error: ' + e.message;
      }
    }

    fab.addEventListener('click', () => {
      unlockAudio();
      fab.classList.add('open');
      panel.classList.add('open');
      renderIntro();
      setTimeout(() => input.focus(), 50);
    });
    close.addEventListener('click', () => {
      fab.classList.remove('open');
      panel.classList.remove('open');
    });
    send.addEventListener('click', () => { unlockAudio(); submit(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    // ── Dictation + continuous-listen ──────────────────────────────────────
    // Creates a fresh SpeechRecognition per session — reusing a single
    // instance caused Chrome to end the follow-up session after ~1s.
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // iOS Safari requires SpeechRecognition.start() to run inside a user
    // gesture. Auto-restart from a timer is silently ignored, so we detect
    // iOS and pulse the mic button instead, waiting for a tap.
    const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const INITIAL_POST_SPEECH_MS    = 2000;
    const FOLLOWUP_POST_SPEECH_MS   = 2500;
    const FOLLOWUP_WAIT_TO_SPEAK_MS = 12000;
    // Persistent session — started once by a user tap and kept alive across
    // Betty's replies. The recognizer is never deliberately stopped between
    // turns; we just suppress incoming results during TTS playback. This
    // works around iOS Safari's rule that SR.start() must run inside a
    // user gesture: as long as the SAME session is still running from the
    // original tap, we don't need a new gesture.
    let session = null;
    let startListening = () => {};

    function endSession() {
      if (!session) return;
      clearTimeout(session.silenceTimer);
      session.ended = true;
      try { session.rec && session.rec.stop(); } catch (_) {}
      session = null;
      mic.classList.remove('rec');
      mic.classList.remove('waiting');
    }

    function suppressSession() {
      if (!session) return;
      // Mark the current results as already-processed so they don't bleed
      // into the next utterance, and pause the silence timer.
      session.suppressed = true;
      session.gotSpeech  = false;
      clearTimeout(session.silenceTimer);
      input.value = '';
    }

    function resumeSession() {
      if (!session) return;
      session.suppressed = false;
      session.gotSpeech  = false;
      // Bump the result baseline to the current results length so anything
      // SR transcribed during TTS (Betty's own voice echoing into the mic)
      // is ignored from now on.
      if (session.rec && session.rec.__results) {
        session.resultBaseIndex = session.rec.__results.length;
      }
      armSilenceTimer();
    }

    function armSilenceTimer() {
      if (!session) return;
      clearTimeout(session.silenceTimer);
      const ms = session.gotSpeech ? FOLLOWUP_POST_SPEECH_MS : FOLLOWUP_WAIT_TO_SPEAK_MS;
      session.silenceTimer = setTimeout(submitUtterance, ms);
    }

    function submitUtterance() {
      if (!session) return;
      const text = input.value.trim();
      if (!text || !session.gotSpeech) {
        // No speech captured during the wait window — keep listening.
        armSilenceTimer();
        return;
      }
      // Capture this utterance and flag the SR state for the next one.
      session.gotSpeech = false;
      session.resultBaseIndex = session.rec && session.rec.__results
        ? session.rec.__results.length : 0;
      lastInputWasVoice = true;
      submit();
      // submit() will set ttsPlaying via speak(); suppressSession() runs
      // from audioEl.onplay so we don't have to do anything else here.
    }

    if (SR) {
      function spawnRec() {
        if (!session || session.ended) return;
        const rec = new SR();
        rec.continuous     = true;
        rec.interimResults = true;
        rec.lang           = 'en-US';
        session.rec = rec;

        rec.onstart = () => {
          mic.classList.add('rec');
          mic.classList.remove('waiting');
          armSilenceTimer();
        };
        rec.onresult = (e) => {
          if (!session || session.suppressed || ttsPlaying) {
            rec.__results = e.results;
            return;
          }
          rec.__results = e.results;
          let interim = '', final = '';
          for (let i = session.resultBaseIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) final += t; else interim += t;
          }
          const combined = (final + ' ' + interim).trim();
          input.value = combined;
          if (combined) { session.gotSpeech = true; armSilenceTimer(); }
        };
        const markSpeech = () => {
          if (session && !session.suppressed && !ttsPlaying) {
            session.gotSpeech = true; armSilenceTimer();
          }
        };
        rec.onspeechstart = markSpeech;
        rec.onsoundstart  = markSpeech;

        rec.onend = () => {
          if (!session || session.ended) { mic.classList.remove('rec'); return; }
          // SR ended on its own — try to relaunch. On iOS this fails silently
          // if we're outside a gesture; we surface that as a "tap to resume"
          // pulse on the mic.
          setTimeout(() => {
            if (!session || session.ended) return;
            try {
              spawnRec();
            } catch (_) {
              mic.classList.remove('rec');
              mic.classList.add('waiting');
              mic.title = 'Tap to resume';
            }
          }, 50);
        };
        rec.onerror = (e) => {
          const err = e && e.error;
          if (err && err !== 'no-speech' && err !== 'aborted') {
            endSession();
          }
        };

        try { rec.start(); }
        catch (_) {
          mic.classList.remove('rec');
          mic.classList.add('waiting');
          mic.title = 'Tap to resume';
        }
      }

      startListening = () => {
        if (session && !session.ended) return;
        if (!panel.classList.contains('open')) return;
        mic.classList.remove('waiting');
        mic.title = 'Dictate';
        session = {
          gotSpeech: false,
          suppressed: false,
          ended: false,
          silenceTimer: null,
          rec: null,
          resultBaseIndex: 0,
        };
        spawnRec();
      };

      mic.addEventListener('click', () => {
        unlockAudio();
        if (session && !session.ended) {
          if (mic.classList.contains('waiting')) {
            mic.classList.remove('waiting');
            try { spawnRec(); } catch (_) {}
            return;
          }
          endSession();
          return;
        }
        startListening();
      });
    } else {
      mic.title = 'Dictation not supported in this browser';
      mic.addEventListener('click', () => { input.focus(); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
