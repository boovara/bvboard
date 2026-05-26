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
      +     '<button id="chat-wake-toggle" aria-label="Toggle wake word" title="Toggle &quot;Hey Betty&quot; wake word">👂</button>'
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
    const wakeBtn  = panel.querySelector('#chat-wake-toggle');
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
    let audioCtx = null;
    let currentSource = null;
    let audioUnlocked = false;

    // Use Web Audio API for TTS playback instead of <audio>. On iOS, an
    // <audio> element switches the OS into a playback audio session that
    // interrupts SpeechRecognition; Web Audio uses a path that coexists
    // with the mic. AudioContext also requires a user-gesture unlock.
    function unlockAudio() {
      if (audioUnlocked) return;
      audioUnlocked = true;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
        // Resume in case it starts suspended (most browsers do).
        if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
        // Brief silent buffer to fully unlock playback in this gesture.
        const silent = audioCtx.createBuffer(1, 1, 22050);
        const src = audioCtx.createBufferSource();
        src.buffer = silent;
        src.connect(audioCtx.destination);
        src.start(0);
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

    // ── Wake word ("Hey Betty") via Picovoice Porcupine ────────────────────
    let wakeOn       = localStorage.getItem('bettyWakeOn') !== '0';
    let porcupine    = null;
    let porcupineReady = false;
    let picovoiceKey = '';
    let currentChatAbort = null;
    let currentTtsAbort  = null;

    // Pull the picovoice access key from /api/config on widget load.
    fetch(CFG.apiBase + '/api/config').then(r => r.json()).then(c => {
      picovoiceKey = c.picovoiceKey || '';
    }).catch(() => {});

    function updateWakeBtn() {
      wakeBtn.classList.toggle('off',    !wakeOn);
      wakeBtn.classList.toggle('active', wakeOn && porcupineReady);
      wakeBtn.title = wakeOn
        ? (porcupineReady ? 'Listening for "Hey Betty" — tap to disable' : 'Wake word enabled (initializing…)')
        : 'Wake word disabled — tap to enable';
    }
    updateWakeBtn();

    async function initPorcupine() {
      if (porcupine || !wakeOn || !picovoiceKey) return;
      try {
        const [{ PorcupineWorker }, { WebVoiceProcessor }] = await Promise.all([
          import('https://cdn.jsdelivr.net/npm/@picovoice/porcupine-web@3.0.3/dist/esm/index.js'),
          import('https://cdn.jsdelivr.net/npm/@picovoice/web-voice-processor@4.0.10/dist/esm/index.js'),
        ]);
        porcupine = await PorcupineWorker.create(
          picovoiceKey,
          [{ publicPath: '/Hey-Betty_en_wasm_v4_0_0.ppn', label: 'Hey Betty' }],
          () => onWakeWord(),
          { publicPath: '/porcupine_params.pv' },
        );
        await WebVoiceProcessor.subscribe(porcupine);
        porcupineReady = true;
        updateWakeBtn();
      } catch (e) {
        console.error('[betty] Porcupine init failed:', e);
        porcupineReady = false;
        updateWakeBtn();
      }
    }

    async function teardownPorcupine() {
      if (!porcupine) return;
      try {
        const { WebVoiceProcessor } = await import('https://cdn.jsdelivr.net/npm/@picovoice/web-voice-processor@4.0.10/dist/esm/index.js');
        await WebVoiceProcessor.unsubscribe(porcupine);
        porcupine.terminate();
      } catch (_) {}
      porcupine = null;
      porcupineReady = false;
      updateWakeBtn();
    }

    function onWakeWord() {
      // Barge-in: cut Betty off if she's mid-anything, then open the mic.
      stopAudio();
      if (currentChatAbort) { try { currentChatAbort.abort(); } catch (_) {} currentChatAbort = null; }
      if (currentTtsAbort)  { try { currentTtsAbort.abort();  } catch (_) {} currentTtsAbort  = null; }
      // Open the panel if closed, then start listening.
      if (!panel.classList.contains('open')) {
        fab.classList.add('open');
        panel.classList.add('open');
        renderIntro();
      }
      // Suspend the wake-word listener briefly so the user's actual
      // utterance doesn't trigger another wake-word detection.
      if (porcupine && porcupine.pause) { try { porcupine.pause(); } catch (_) {} }
      lastInputWasVoice = true;
      try { startListening(); } catch (_) {}
    }

    wakeBtn.addEventListener('click', () => {
      wakeOn = !wakeOn;
      localStorage.setItem('bettyWakeOn', wakeOn ? '1' : '0');
      if (wakeOn) initPorcupine();
      else        teardownPorcupine();
      updateWakeBtn();
    });

    let ttsPlaying = false;

    function stopAudio() {
      try {
        if (currentSource) { currentSource.onended = null; currentSource.stop(); }
      } catch (_) {}
      currentSource = null;
      ttsPlaying = false;
    }

    async function speak(text, onEnd) {
      if (!voiceOn || !text) { onEnd && onEnd(); return; }
      stopAudio();
      if (!audioCtx) { onEnd && onEnd(); return; }
      currentTtsAbort = new AbortController();
      try {
        const r = await fetch(CFG.apiBase + '/api/tts', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ text }),
          signal: currentTtsAbort.signal,
        });
        if (!r.ok) { onEnd && onEnd(); return; }
        const buf = await r.arrayBuffer();
        // Some browsers (Safari) only support the older callback form of
        // decodeAudioData, so fall back gracefully.
        const audioBuffer = await new Promise((resolve, reject) => {
          try {
            const p = audioCtx.decodeAudioData(buf, resolve, reject);
            if (p && p.then) p.then(resolve, reject);
          } catch (e) { reject(e); }
        });
        if (audioCtx.state === 'suspended' && audioCtx.resume) {
          try { await audioCtx.resume(); } catch (_) {}
        }
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(audioCtx.destination);
        currentSource = src;
        ttsPlaying = true;
        if (session) suppressSession();
        // Wake up Porcupine again so the user can interrupt Betty mid-sentence
        // with another "Hey Betty". Echo cancellation on the mic capture
        // prevents Betty's own voice from triggering the wake word.
        if (porcupine && porcupine.resume) { try { porcupine.resume(); } catch (_) {} }
        tlog('TTS audio start (duration ~' + audioBuffer.duration.toFixed(1) + 's)');
        src.onended = () => {
          if (currentSource === src) currentSource = null;
          ttsPlaying = false;
          currentTtsAbort = null;
          tlog('TTS audio ended');
          // Resume Porcupine wake-word listening for the next interrupt.
          if (porcupine && porcupine.resume) { try { porcupine.resume(); } catch (_) {} }
          if (session) resumeSession();
          onEnd && onEnd();
        };
        src.start(0);
      } catch (_) {
        ttsPlaying = false;
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
          currentChatAbort = new AbortController();
          const resp = await fetch(CFG.apiBase + '/api/chat', {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
            body: JSON.stringify(action === 'confirm'
              ? { confirm: { name: pending.name, input: pending.input }, tz: clientTZ() }
              : { cancel: { name: pending.name }, tz: clientTZ() }),
            signal: currentChatAbort.signal,
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
      currentChatAbort = new AbortController();
      try {
        const resp = await fetch(CFG.apiBase + '/api/chat', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ messages: history, tz: clientTZ() }),
          signal: currentChatAbort.signal,
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
      // First open of the panel = best opportunity to ask for mic permission
      // and boot Porcupine inside a user gesture (required by iOS Safari).
      if (wakeOn && !porcupine) initPorcupine();
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
    // Set localStorage.bettyDebug = '1' in DevTools to see timing logs.
    const DBG = (typeof localStorage !== 'undefined' && localStorage.getItem('bettyDebug') === '1');
    const tlog = (label) => { if (DBG) console.log('[betty]', performance.now().toFixed(0) + 'ms', label); };

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // iOS Safari requires SpeechRecognition.start() to run inside a user
    // gesture. Auto-restart from a timer is silently ignored, so we detect
    // iOS and pulse the mic button instead, waiting for a tap.
    const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // After ANY interim result arrives we wait this long before submitting —
    // tolerates natural mid-sentence pauses without cutting the user off.
    const POST_INTERIM_MS = 1500;
    // After a FINAL result the recognizer has already committed that segment;
    // we can submit much faster.
    const POST_FINAL_MS   = 200;
    // How long to wait for the user to start talking after Betty's reply.
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
      tlog('suppressSession (TTS starting)');
      session.suppressed = true;
      session.gotSpeech  = false;
      clearTimeout(session.silenceTimer);
      input.value = '';
    }

    function resumeSession() {
      if (!session) return;
      // Stop and respawn SR after TTS ends. Reusing the same recognizer left
      // it with stale audio buffers from Betty's own voice, which made the
      // user's first 1-2 follow-up utterances get swallowed. A fresh SR
      // instance starts with a clean buffer and reliably picks up the user.
      if (DBG) console.log('[betty] resumeSession → respawn fresh SR');
      session.suppressed = false;
      session.gotSpeech  = false;
      session.resultBaseIndex = 0;
      input.value = '';
      const old = session.rec;
      session.rec = null;
      try { old && old.abort && old.abort(); } catch (_) {}
      try { old && old.stop  && old.stop();  } catch (_) {}
      // Give the audio subsystem ~150ms to release the mic capture before we
      // open a fresh recognizer.
      setTimeout(() => { if (session && !session.ended) spawnRec(); }, 150);
    }

    function armSilenceTimer(stage) {
      if (!session) return;
      clearTimeout(session.silenceTimer);
      // stage: 'pre'  = haven't heard speech yet
      //        'interim' = receiving partial transcripts
      //        'final'   = recognizer committed a final segment
      let ms;
      if (stage === 'final')        ms = POST_FINAL_MS;
      else if (session.gotSpeech)   ms = POST_INTERIM_MS;
      else                          ms = FOLLOWUP_WAIT_TO_SPEAK_MS;
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
          tlog('rec.onstart');
          mic.classList.add('rec');
          mic.classList.remove('waiting');
          armSilenceTimer();
        };
        rec.onresult = (e) => {
          if (!session || session.suppressed || ttsPlaying) {
            rec.__results = e.results;
            tlog('rec.onresult ignored (suppressed/ttsPlaying)');
            return;
          }
          rec.__results = e.results;
          let interim = '', final = '';
          let sawFinal = false;
          for (let i = session.resultBaseIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) { final += t; sawFinal = true; }
            else                       { interim += t; }
          }
          const combined = (final + ' ' + interim).trim();
          input.value = combined;
          if (combined) {
            tlog('rec.onresult ' + (sawFinal ? 'final' : 'interim') + ' "' + combined + '"');
            session.gotSpeech = true;
            armSilenceTimer(sawFinal ? 'final' : 'interim');
          }
        };
        const markSpeech = () => {
          if (session && !session.suppressed && !ttsPlaying) {
            session.gotSpeech = true; armSilenceTimer('interim');
          }
        };
        rec.onspeechstart = markSpeech;
        rec.onsoundstart  = markSpeech;
        // Speech-end signal — fastest "user stopped talking" trigger.
        rec.onspeechend = () => {
          if (session && !session.suppressed && !ttsPlaying && session.gotSpeech) {
            armSilenceTimer('final');
          }
        };

        rec.onend = () => {
          tlog('rec.onend');
          if (!session || session.ended) { mic.classList.remove('rec'); return; }
          // SR ended on its own — try to relaunch. On iOS this fails silently
          // if we're outside a gesture; we surface that as a "tap to resume"
          // pulse on the mic.
          setTimeout(() => {
            if (!session || session.ended) return;
            // If resumeSession already kicked off a respawn (rec === null),
            // don't double-spawn from here.
            if (session.rec) return;
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
          tlog('rec.onerror ' + (e && e.error));
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
