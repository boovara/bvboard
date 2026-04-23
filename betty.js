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
      + '<h3>Ask <em>Betty</em></h3>'
      + '<div style="display:flex; gap:4px; align-items:center;">'
      +   '<button id="chat-voice-toggle" aria-label="Toggle voice" title="Toggle voice replies">🔊</button>'
      +   '<button id="chat-close" aria-label="Close">×</button>'
      + '</div>'
      + '</div>'
      + '<div id="chat-log"></div>'
      + '<div id="chat-input-row">'
      +   '<button class="chat-btn mic" id="chat-mic" aria-label="Dictate">' + MIC_SVG + '</button>'
      +   '<textarea id="chat-input" rows="1" placeholder="' + CFG.placeholder.replace(/"/g, '&quot;') + '"></textarea>'
      +   '<button class="chat-btn send" id="chat-send" aria-label="Send">' + SEND_SVG + '</button>'
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

    const history = [];
    let introShown = false;
    let lastInputWasVoice = false;

    // ── TTS (ElevenLabs via /api/tts) ──────────────────────────────────────
    let voiceOn = localStorage.getItem('bettyVoiceOn') !== '0';
    const audioEl = new Audio();
    let currentAudioUrl = null;

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
    }

    async function speak(text, onEnd) {
      if (!voiceOn || !text) { onEnd && onEnd(); return; }
      stopAudio();
      try {
        const r = await fetch(CFG.apiBase + '/api/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) { onEnd && onEnd(); return; }
        const blob = await r.blob();
        currentAudioUrl = URL.createObjectURL(blob);
        audioEl.src = currentAudioUrl;
        audioEl.onended = () => { stopAudio(); onEnd && onEnd(); };
        audioEl.onerror = () => { stopAudio(); onEnd && onEnd(); };
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
      addMsg('user', text);
      history.push({ role: 'user', content: text });

      const typingEl = showTyping();
      try {
        const resp = await fetch(CFG.apiBase + '/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: history }),
        });
        const data = await resp.json().catch(() => ({}));
        typingEl.remove();
        if (!resp.ok) {
          addMsg('bot', 'Error: ' + (data.error || resp.status));
          return;
        }
        const replyText = data.text || '(no response)';
        addMsg('bot', replyText);
        if (data.text) {
          history.push({ role: 'assistant', content: data.text });
          if (wasVoice) speak(data.text, () => startListening(true));
        }
      } catch (e) {
        typingEl.textContent = 'Error: ' + e.message;
      }
    }

    fab.addEventListener('click', () => {
      fab.classList.add('open');
      panel.classList.add('open');
      renderIntro();
      setTimeout(() => input.focus(), 50);
    });
    close.addEventListener('click', () => {
      fab.classList.remove('open');
      panel.classList.remove('open');
    });
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    // ── Dictation + continuous-listen w/ 5s silence timeout ────────────────
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let startListening = () => {};
    if (SR) {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';

      let recording = false;
      let base = '';
      let silenceTimer = null;
      let gotSpeech = false;
      const SILENCE_MS = 5000;

      function armSilenceTimer() {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => { try { rec.stop(); } catch (_) {} }, SILENCE_MS);
      }

      rec.onstart = () => {
        recording = true;
        mic.classList.add('rec');
        gotSpeech = false;
        armSilenceTimer();
      };
      rec.onresult = (e) => {
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t; else interim += t;
        }
        const combined = (base + ' ' + final + ' ' + interim).trim();
        input.value = combined;
        if (combined) { gotSpeech = true; armSilenceTimer(); }
      };
      rec.onspeechstart = () => { gotSpeech = true; armSilenceTimer(); };
      rec.onend = () => {
        clearTimeout(silenceTimer);
        recording = false;
        mic.classList.remove('rec');
        if (gotSpeech && input.value.trim()) {
          lastInputWasVoice = true;
          submit();
        }
      };
      rec.onerror = () => {
        clearTimeout(silenceTimer);
        recording = false;
        mic.classList.remove('rec');
      };

      startListening = (autoFollowUp) => {
        if (recording) return;
        if (!panel.classList.contains('open')) return;
        base = autoFollowUp ? '' : input.value;
        if (autoFollowUp) input.value = '';
        try { rec.start(); } catch (_) {}
      };

      mic.addEventListener('click', () => {
        if (recording) { try { rec.stop(); } catch (_) {} return; }
        startListening(false);
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
