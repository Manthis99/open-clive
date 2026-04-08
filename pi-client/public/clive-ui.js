/**
 * Clive UI — Chat-first companion interface
 * WebSocket, audio capture/playback, VAD, auto-listen, barge-in,
 * chat bubbles, voice overlay, settings persistence.
 */

const CLIVE_CONFIG = window.CLIVE_CONFIG || {};
const WS_URL = CLIVE_CONFIG.hostWsUrl || `ws://${location.hostname || 'localhost'}:3100`;
const STATUS_URL = `${(CLIVE_CONFIG.hostHttpUrl || `http://${location.hostname || 'localhost'}:3100`).replace(/\/$/, '')}/api/status`;

// ---- DOM refs ----

const app           = document.getElementById('app');
const stateLabel    = document.getElementById('state-label');
const clockDisplay  = document.getElementById('clock-display');
const connectionDot = document.getElementById('connection-dot');
const chat          = document.getElementById('chat');
const chatInner     = document.getElementById('chat-inner');
const chatEmpty     = document.getElementById('chat-empty');
const textInput     = document.getElementById('text-input');
const btnTextSend   = document.getElementById('btn-text-send');
const btnPTT        = document.getElementById('btn-push-to-talk');
const voiceOverlay  = document.getElementById('voice-overlay');
const voiceLabel    = document.getElementById('voice-label');
const voiceTask     = document.getElementById('voice-task');
const btnVoiceCancel = document.getElementById('btn-voice-cancel');
const confirmation  = document.getElementById('confirmation');
const confirmMessage = document.getElementById('confirm-message');
const btnConfirm    = document.getElementById('btn-confirm');
const btnDeny       = document.getElementById('btn-deny');
const settingsPanel = document.getElementById('settings-panel');
const settingsBackdrop = document.getElementById('settings-backdrop');
const btnSettings   = document.getElementById('btn-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnExitKiosk  = document.getElementById('btn-exit-kiosk');

// Settings controls
const settingAutoListen       = document.getElementById('setting-auto-listen');
const settingBargeIn          = document.getElementById('setting-barge-in');
const settingAutoListenTimeout = document.getElementById('setting-auto-listen-timeout');
const settingAmbientMotion    = document.getElementById('setting-ambient-motion');
const settingLargeText        = document.getElementById('setting-large-text');
const settingTtsEnabled       = document.getElementById('setting-tts-enabled');

// System status (inside settings panel)
const metricMode         = document.getElementById('metric-mode');
const metricWakeWord     = document.getElementById('metric-wake-word');
const metricAudio        = document.getElementById('metric-audio');
const hostAgentId        = document.getElementById('host-agent-id');
const hostAgentHealth    = document.getElementById('host-agent-health');
const hostLastTranscript = document.getElementById('host-last-transcript');

// ---- State ----

let ws = null;
let currentState = 'idle';
let voiceMode = false;          // true when current/last turn was initiated by voice
let mediaStream = null;
let audioContext = null;
let audioProcessor = null;
let mediaSource = null;
let passiveMonitorProcessor = null;
let passiveMonitorSink = null;
let isRecording = false;
let isStartingRecording = false;
let pendingStopAfterStart = false;
let micAvailable = true;
let manualPTT = false;
let activePointerId = null;

// Chat
let currentTranscript = '';
let currentResponse = '';
let currentCliveBubble = null;  // the most recent Clive bubble element
let pendingBubbleEl = null;     // the in-progress thinking/working bubble
const MAX_BUBBLES = 24;

// Audio playback
let audioQueue = [];
let isPlaying = false;
let currentAudioSource = null;
let suppressAutoListenOnce = false;
let serverAudioEnded = false;
let deferredState = null;
let bargeInArmed = false;
let bargeInFrameCount = 0;
let lastBargeInAt = 0;

const BARGE_IN_THRESHOLD = 0.028;
const BARGE_IN_MIN_FRAMES = 2;
const BARGE_IN_COOLDOWN_MS = 1800;
let autoListenNoSpeechTimeout = 5000;

// VAD
const VAD_ENERGY_THRESHOLD = 0.015;
const VAD_SILENCE_TIMEOUT = 1800;
const VAD_NO_SPEECH_TIMEOUT = 5000;
let autoListenEnabled = true;
let vadSpeechDetected = false;
let vadSilenceTimer = null;
let vadNoSpeechTimer = null;
let isAutoListening = false;
let autoListenStartupTimer = null;
let lastHostStatus = null;
let listenerConnected = false;

// ---- Settings ----

const SETTINGS_KEY = 'clive_dashboard_settings_v1';

function loadSettings() {
  const defaults = {
    autoListen: true,
    autoListenTimeoutMs: 5000,
    bargeIn: true,
    ambientMotion: true,
    largeText: false,
    ttsEnabled: true,
  };
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return defaults;
    return { ...defaults, ...JSON.parse(saved) };
  } catch { return defaults; }
}

const settings = loadSettings();

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---- WebSocket ----

function connect() {
  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    send('client_hello', { role: 'display', canReceiveAudio: settings.ttsEnabled });
    connectionDot.classList.add('connected');
    updateDashboard();
  };

  ws.onclose = () => {
    connectionDot.classList.remove('connected');
    updateDashboard();
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {};

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleAudioChunk(event.data);
      return;
    }
    try {
      handleMessage(JSON.parse(event.data));
    } catch (e) {
      console.error('[WS] Bad message:', e);
    }
  };
}

// ---- Messages ----

function handleMessage(msg) {
  switch (msg.type) {
    case 'state_change':        setState(msg.payload.state); break;
    case 'transcript':          showTranscript(msg.payload.text); break;
    case 'response_text':       showResponse(msg.payload.text, msg.payload.streaming); break;
    case 'response_audio_end':
      serverAudioEnded = true;
      if (!isPlaybackActive()) onAudioPlaybackDone();
      break;
    case 'response_display':    showDisplayCard(msg.payload.text, msg.payload.summary); break;
    case 'task_status':         showTaskStatus(msg.payload.label, msg.payload.progress); break;
    case 'confirmation_request': showConfirmation(msg.payload.message); break;
    case 'error':               showError(msg.payload.error); break;
  }
}

function handleAudioChunk(buffer) {
  serverAudioEnded = false;
  audioQueue.push(buffer);
  if (!isPlaying) playNextChunk();
}

// ---- State Machine ----

const stateLabels = {
  idle:      'ready',
  listening: 'listening',
  thinking:  'thinking',
  speaking:  'speaking',
  working:   'working',
  confirming: 'confirm',
  error:     'error',
};

function setState(newState) {
  if (newState === 'idle' && isPlaybackActive()) {
    deferredState = 'idle';
    return;
  }

  if (currentState === newState) return;
  const prevState = currentState;
  currentState = newState;

  app.className = `state-${newState}`;
  stateLabel.textContent = stateLabels[newState] || newState;

  // Voice overlay: show when voice-initiated, hide on terminal states
  if (voiceMode && ['listening', 'thinking', 'working'].includes(newState)) {
    showVoiceOverlay(newState);
  } else if (['speaking', 'idle', 'error', 'confirming'].includes(newState)) {
    hideVoiceOverlay();
  }

  // For text turns: show pending bubble on thinking/working
  if (!voiceMode && ['thinking', 'working'].includes(newState) && !pendingBubbleEl) {
    showPendingBubble();
  }

  // Clear voiceMode on terminal states (speaking hides overlay, idle/error fully reset)
  if (['speaking', 'idle', 'error'].includes(newState)) {
    voiceMode = false;
  }

  // Mic button
  btnPTT.classList.toggle('recording', newState === 'listening');

  // Speaking border on current Clive bubble
  if (currentCliveBubble) {
    currentCliveBubble.classList.toggle('bubble-speaking', newState === 'speaking');
  }

  // Clear confirmation on new turn
  if (newState === 'listening') {
    confirmation.classList.add('hidden');
  }

  // Clean up refs when fully idle
  if (newState === 'idle') {
    setTimeout(() => {
      if (currentState === 'idle') {
        currentCliveBubble = null;
        currentTranscript = '';
        currentResponse = '';
      }
    }, 200);
  }

  if (newState === 'error') {
    setTimeout(() => { if (currentState === 'error') setState('idle'); }, 5000);
  }

  updateDashboard();
}

// ---- Auto-Listen ----

function onAudioPlaybackDone() {
  currentAudioSource = null;
  serverAudioEnded = false;

  if (deferredState) {
    const next = deferredState;
    deferredState = null;
    setState(next);
  }

  if (suppressAutoListenOnce) { suppressAutoListenOnce = false; return; }
  if (!autoListenEnabled || !micAvailable || !canUseBrowserMic()) return;
  if (currentState === 'error' || currentState === 'confirming') return;

  if (autoListenStartupTimer) { clearTimeout(autoListenStartupTimer); autoListenStartupTimer = null; }
  autoListenStartupTimer = setTimeout(() => {
    if (!suppressAutoListenOnce && (currentState === 'speaking' || currentState === 'idle')) startAutoListen();
  }, 400);
}

async function startAutoListen() {
  if (isRecording || isAutoListening || !canUseBrowserMic()) return;
  isAutoListening = true;
  vadSpeechDetected = false;

  try {
    voiceMode = true;
    await startRecording(true);
    vadNoSpeechTimer = setTimeout(() => {
      if (isAutoListening && !vadSpeechDetected) stopAutoListen(false);
    }, autoListenNoSpeechTimeout);
  } catch (e) {
    console.error('[AutoListen] Failed:', e);
    isAutoListening = false;
    voiceMode = false;
  }
}

function stopAutoListen(sendAudio = true) {
  clearVADTimers();
  isAutoListening = false;
  if (isRecording) {
    sendAudio ? stopRecording() : cancelRecording();
  }
}

function clearVADTimers() {
  if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
  if (vadNoSpeechTimer) { clearTimeout(vadNoSpeechTimer); vadNoSpeechTimer = null; }
}

// ---- VAD ----

function processVAD(pcmData) {
  if (!isAutoListening) return;
  let sum = 0;
  for (let i = 0; i < pcmData.length; i++) sum += pcmData[i] * pcmData[i];
  const rms = Math.sqrt(sum / pcmData.length);

  if (rms > VAD_ENERGY_THRESHOLD) {
    if (!vadSpeechDetected) {
      vadSpeechDetected = true;
      if (vadNoSpeechTimer) { clearTimeout(vadNoSpeechTimer); vadNoSpeechTimer = null; }
    }
    if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
  } else if (vadSpeechDetected && !vadSilenceTimer) {
    vadSilenceTimer = setTimeout(() => stopAutoListen(true), VAD_SILENCE_TIMEOUT);
  }
}

// ---- Chat / Bubble Management ----

function scrollChat() {
  chat.scrollTop = chat.scrollHeight;
  // Prune oldest bubbles to keep DOM lean
  while (chatInner.children.length > MAX_BUBBLES) {
    const oldest = chatInner.firstChild;
    if (oldest === pendingBubbleEl) break;
    chatInner.removeChild(oldest);
  }
}

function hideChatEmpty() {
  if (chatEmpty && !chatEmpty.classList.contains('hidden')) {
    chatEmpty.classList.add('hidden');
  }
}

function addUserBubble(text) {
  hideChatEmpty();
  const el = document.createElement('div');
  el.className = 'bubble bubble-user';
  const body = document.createElement('div');
  body.className = 'bubble-body';
  body.textContent = text;
  el.appendChild(body);
  chatInner.appendChild(el);
  scrollChat();
  return el;
}

function addCliveBubble(text) {
  hideChatEmpty();
  const el = document.createElement('div');
  el.className = 'bubble bubble-clive';
  const avatar = document.createElement('div');
  avatar.className = 'bubble-avatar';
  const body = document.createElement('div');
  body.className = 'bubble-body';
  const textEl = document.createElement('div');
  textEl.className = 'bubble-text';
  textEl.textContent = text;
  body.appendChild(textEl);
  el.appendChild(avatar);
  el.appendChild(body);
  chatInner.appendChild(el);
  scrollChat();
  currentCliveBubble = el;
  return el;
}

function showPendingBubble() {
  if (pendingBubbleEl) return;
  hideChatEmpty();
  const el = document.createElement('div');
  el.className = 'bubble bubble-clive bubble-pending';
  const avatar = document.createElement('div');
  avatar.className = 'bubble-avatar';
  const body = document.createElement('div');
  body.className = 'bubble-body';
  const dots = document.createElement('div');
  dots.className = 'thinking-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  const taskEl = document.createElement('div');
  taskEl.className = 'pending-task hidden';
  body.appendChild(dots);
  body.appendChild(taskEl);
  el.appendChild(avatar);
  el.appendChild(body);
  chatInner.appendChild(el);
  scrollChat();
  pendingBubbleEl = el;
}

function updatePendingBubble(progress) {
  if (!pendingBubbleEl) return;
  const p = (progress || '').trim();
  const t = (currentTranscript || '').trim();
  if (!p || p === t) return;
  const taskEl = pendingBubbleEl.querySelector('.pending-task');
  const dots = pendingBubbleEl.querySelector('.thinking-dots');
  if (taskEl && dots) {
    dots.classList.add('hidden');
    taskEl.classList.remove('hidden');
    taskEl.textContent = p;
  }
  scrollChat();
}

function resolvePendingBubble(text) {
  if (!pendingBubbleEl) {
    addCliveBubble(text);
    return;
  }
  const body = pendingBubbleEl.querySelector('.bubble-body');
  if (body) {
    body.innerHTML = '';
    const textEl = document.createElement('div');
    textEl.className = 'bubble-text';
    textEl.textContent = text;
    body.appendChild(textEl);
  }
  pendingBubbleEl.classList.remove('bubble-pending');
  currentCliveBubble = pendingBubbleEl;
  pendingBubbleEl = null;
  scrollChat();
}

// ---- Voice Overlay ----

function showVoiceOverlay(state) {
  const labels = { listening: 'Listening', thinking: 'Processing', working: 'Working' };
  voiceOverlay.classList.remove('hidden', 'mode-listening', 'mode-thinking', 'mode-working');
  voiceOverlay.classList.add(`mode-${state}`);
  voiceLabel.textContent = labels[state] || state;
  if (state !== 'working') voiceTask.textContent = '';
}

function hideVoiceOverlay() {
  voiceOverlay.classList.add('hidden');
  voiceTask.textContent = '';
}

// ---- UI Updates ----

function showTranscript(text) {
  currentTranscript = text;
  if (voiceMode) {
    // Voice turn: add user bubble to chat (overlay is still showing on top)
    addUserBubble(text);
  }
  // Text turns: bubble already added in submitTextInput()
}

function showResponse(text, streaming = false) {
  currentResponse = text;
  if (voiceMode) {
    // Add Clive bubble to chat behind the overlay — will be revealed when overlay hides
    if (!currentCliveBubble) {
      addCliveBubble(text);
    } else {
      const textEl = currentCliveBubble.querySelector('.bubble-text');
      if (textEl) textEl.textContent = text;
    }
  } else {
    resolvePendingBubble(text);
  }
}

function showTaskStatus(label, progress) {
  const p = (progress || '').trim();
  const t = (currentTranscript || '').trim();
  const display = (p && p !== t) ? p : '';

  if (voiceMode) {
    if (display) {
      voiceTask.textContent = display;
      voiceTask.scrollTop = voiceTask.scrollHeight;
    }
  } else {
    updatePendingBubble(display || progress);
  }
}

function showConfirmation(message) {
  confirmMessage.textContent = message;
  confirmation.classList.remove('hidden');
}

function showDisplayCard(fullText, summary) {
  currentResponse = summary || fullText.substring(0, 120) + '...';

  // Ensure we have a bubble to attach the card to
  if (!currentCliveBubble) addCliveBubble(summary || '');

  const body = currentCliveBubble.querySelector('.bubble-body');
  if (!body) return;

  // Update the summary text
  const textEl = body.querySelector('.bubble-text');
  if (textEl && summary) textEl.textContent = summary;

  // Add expand/collapse toggle
  const expandBtn = document.createElement('button');
  expandBtn.className = 'expand-btn';
  expandBtn.textContent = 'Show details ↓';

  const details = document.createElement('div');
  details.className = 'bubble-details hidden';
  details.innerHTML = formatDisplayContent(fullText);

  expandBtn.addEventListener('click', () => {
    const isOpen = !details.classList.contains('hidden');
    details.classList.toggle('hidden', isOpen);
    expandBtn.textContent = isOpen ? 'Show details ↓' : 'Hide details ↑';
    scrollChat();
  });

  body.appendChild(expandBtn);
  body.appendChild(details);
  scrollChat();
}

function formatDisplayContent(text) {
  const lines = text.split('\n');
  let html = '';
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) { html += '</ul>'; inList = false; }
      continue;
    }

    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<img src="${imgMatch[2]}" alt="${esc(imgMatch[1])}" class="dc-image" loading="lazy" />`;
      continue;
    }

    if (/^\*\*(.+?)\*\*/.test(trimmed)) {
      if (inList) { html += '</ul>'; inList = false; }
      const title = trimmed.replace(/\*\*(.+?)\*\*/g, '$1').replace(/[-–]$/, '').trim();
      html += `<div class="dc-section">${esc(title)}</div>`;
      continue;
    }

    const listMatch = trimmed.match(/^\s*[-*•]\s+(.+)/) || trimmed.match(/^\s*\d+[.)]\s+(.+)/);
    if (listMatch) {
      if (!inList) { html += '<ul class="dc-list">'; inList = true; }
      const content = listMatch[1].replace(/`([^`]+)`/g, '<code>$1</code>');
      html += `<li>${content}</li>`;
      continue;
    }

    if (inList) { html += '</ul>'; inList = false; }
    html += `<p class="dc-para">${esc(trimmed)}</p>`;
  }

  if (inList) html += '</ul>';
  return html;
}

function showError(error) {
  setState('error');
  const el = document.createElement('div');
  el.className = 'bubble bubble-clive bubble-error';
  const avatar = document.createElement('div');
  avatar.className = 'bubble-avatar';
  const body = document.createElement('div');
  body.className = 'bubble-body';
  body.textContent = error || 'Something went wrong.';
  el.appendChild(avatar);
  el.appendChild(body);
  hideChatEmpty();
  chatInner.appendChild(el);
  scrollChat();
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ---- Audio Playback ----

async function playNextChunk() {
  if (audioQueue.length === 0) {
    isPlaying = false;
    currentAudioSource = null;
    if (serverAudioEnded) onAudioPlaybackDone();
    return;
  }

  isPlaying = true;
  const buffer = audioQueue.shift();

  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
    const source = audioContext.createBufferSource();
    currentAudioSource = source;
    source.buffer = audioBuffer;
    source.playbackRate.value = 1.0;
    source.connect(audioContext.destination);
    source.onended = () => {
      if (currentAudioSource === source) currentAudioSource = null;
      playNextChunk();
    };
    source.start();
  } catch (e) {
    console.error('[Audio] Playback error:', e);
    playNextChunk();
  }
}

// ---- Audio Capture ----

function canUseBrowserMic() {
  return true;
}

function releaseBrowserMic() {
  if (audioProcessor)        { audioProcessor.disconnect(); audioProcessor = null; }
  if (passiveMonitorProcessor) { passiveMonitorProcessor.disconnect(); passiveMonitorProcessor = null; }
  if (passiveMonitorSink)    { passiveMonitorSink.disconnect(); passiveMonitorSink = null; }
  if (mediaSource)           { mediaSource.disconnect(); mediaSource = null; }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  isRecording = false;
  isStartingRecording = false;
  pendingStopAfterStart = false;
}

async function ensureMicAccess() {
  if (!mediaStream) {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true }
    });
    micAvailable = true;
    updateDashboard();
  }
  audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  if (!mediaSource) mediaSource = audioContext.createMediaStreamSource(mediaStream);
  if (!passiveMonitorProcessor) initPassiveMonitor();
}

function initPassiveMonitor() {
  passiveMonitorProcessor = audioContext.createScriptProcessor(2048, 1, 1);
  passiveMonitorSink = audioContext.createGain();
  passiveMonitorSink.gain.value = 0;
  passiveMonitorProcessor.onaudioprocess = (e) => processBargeIn(e.inputBuffer.getChannelData(0));
  mediaSource.connect(passiveMonitorProcessor);
  passiveMonitorProcessor.connect(passiveMonitorSink);
  passiveMonitorSink.connect(audioContext.destination);
}

async function startRecording(isAuto = false) {
  if (!canUseBrowserMic()) { micAvailable = false; updateDashboard(); return; }
  if (isRecording || isStartingRecording) return;
  isStartingRecording = true;
  pendingStopAfterStart = false;
  try {
    await ensureMicAccess();
    audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    audioProcessor.onaudioprocess = (e) => {
      if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;
      const pcm = e.inputBuffer.getChannelData(0);
      processVAD(pcm);
      const int16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) int16[i] = Math.max(-32768, Math.min(32767, pcm[i] * 32768));
      ws.send(int16.buffer);
    };
    mediaSource.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
    isRecording = true;
    send('press_to_talk_start');
    setState('listening');
    if (pendingStopAfterStart) { pendingStopAfterStart = false; stopRecording(); }
  } catch (e) {
    console.error('[Audio] Capture error:', e);
    micAvailable = false;
    voiceMode = false;
    updateDashboard();
    if (!isAuto) simulateInteraction();
  } finally {
    isStartingRecording = false;
  }
}

function processBargeIn(pcmData) {
  const now = Date.now();
  const canBargeIn =
    canUseBrowserMic() &&
    settings.bargeIn &&
    ['speaking', 'thinking', 'working'].includes(currentState) &&
    !isRecording && !manualPTT &&
    now - lastBargeInAt > BARGE_IN_COOLDOWN_MS;

  if (!canBargeIn) { bargeInArmed = false; bargeInFrameCount = 0; return; }

  let sum = 0;
  for (let i = 0; i < pcmData.length; i++) sum += pcmData[i] * pcmData[i];
  const rms = Math.sqrt(sum / pcmData.length);

  if (rms > BARGE_IN_THRESHOLD) { bargeInFrameCount++; bargeInArmed = true; }
  else { bargeInFrameCount = 0; bargeInArmed = false; }

  if (bargeInArmed && bargeInFrameCount >= BARGE_IN_MIN_FRAMES) {
    lastBargeInAt = now;
    bargeInArmed = false;
    bargeInFrameCount = 0;
    interruptClive();
    setTimeout(() => { if (!isRecording) startRecording(true); }, 50);
  }
}

function stopRecording() {
  if (isStartingRecording && !isRecording) { pendingStopAfterStart = true; return; }
  if (!isRecording) return;
  isRecording = false;
  clearVADTimers();
  isAutoListening = false;
  manualPTT = false;
  if (audioProcessor) { audioProcessor.disconnect(); audioProcessor = null; }
  send('press_to_talk_end');
}

function cancelRecording() {
  if (isStartingRecording && !isRecording) { pendingStopAfterStart = false; isStartingRecording = false; return; }
  if (!isRecording) return;
  isRecording = false;
  clearVADTimers();
  isAutoListening = false;
  manualPTT = false;
  voiceMode = false;
  if (audioProcessor) { audioProcessor.disconnect(); audioProcessor = null; }
  send('cancel');
  setState('idle');
}

function simulateInteraction() {
  send('press_to_talk_start');
  setTimeout(() => send('press_to_talk_end'), 800);
}

// ---- Text Input ----

function submitTextInput() {
  if (!textInput) return;
  const text = textInput.value.trim();
  if (!text) return;
  if (['listening', 'thinking', 'working', 'speaking'].includes(currentState)) return;
  textInput.value = '';
  btnTextSend.classList.remove('visible');
  currentTranscript = text;
  addUserBubble(text);
  send('text_input', { text });
}

// ---- Helpers ----

function send(type, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
}

function isPlaybackActive() {
  return isPlaying || audioQueue.length > 0 || !!currentAudioSource;
}

function stopPlayback() {
  suppressAutoListenOnce = true;
  serverAudioEnded = false;
  deferredState = null;
  audioQueue = [];
  isPlaying = false;
  if (currentAudioSource) {
    try { currentAudioSource.onended = null; currentAudioSource.stop(); } catch {}
    currentAudioSource = null;
  }
}

function interruptClive() {
  if (autoListenStartupTimer) { clearTimeout(autoListenStartupTimer); autoListenStartupTimer = null; }
  stopPlayback();
  stopAutoListen(false);
  if (isRecording) cancelRecording();
  if (pendingBubbleEl) { pendingBubbleEl.remove(); pendingBubbleEl = null; }
  send('cancel');
  setState('idle');
}

// ---- Dashboard ----

function updateClock() {
  if (clockDisplay) clockDisplay.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function updateDashboard() {
  if (metricMode)     metricMode.textContent = stateLabels[currentState] || currentState;
  if (metricWakeWord) metricWakeWord.textContent = listenerConnected ? 'Listener online' : 'Push-to-talk';
  if (metricAudio) {
    metricAudio.textContent = listenerConnected
      ? 'Listener'
      : micAvailable ? (isRecording ? 'Listening' : isStartingRecording ? 'Arming' : 'Ready') : 'Blocked';
  }
  if (lastHostStatus) {
    if (hostAgentId)        hostAgentId.textContent        = lastHostStatus.agent?.agentId || 'Unknown';
    if (hostAgentHealth)    hostAgentHealth.textContent    = lastHostStatus.agent?.healthy ? 'Healthy' : 'Degraded';
    if (hostLastTranscript) hostLastTranscript.textContent = truncate(lastHostStatus.host?.lastTranscript, 32);
  }
}

async function refreshHostStatus() {
  try {
    const r = await fetch(STATUS_URL, { cache: 'no-store' });
    if (!r.ok) return;
    lastHostStatus = await r.json();
    const nextListenerConnected = (lastHostStatus.host?.listenerClients || 0) > 0;
    if (nextListenerConnected !== listenerConnected) {
      listenerConnected = nextListenerConnected;
      if (listenerConnected) {
        stopAutoListen(false);
        btnPTT.classList.remove('recording');
      } else {
        micAvailable = true;
      }
    }
    updateDashboard();
  } catch {}
}

function truncate(text, max) {
  if (!text || text.length <= max) return text || 'Waiting';
  return text.slice(0, max - 1) + '…';
}

// ---- Settings ----

function openSettings() {
  settingsPanel.classList.remove('hidden');
  settingsPanel.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsPanel.setAttribute('aria-hidden', 'true');
}

function applySettings() {
  autoListenEnabled = settings.autoListen;
  autoListenNoSpeechTimeout = settings.autoListenTimeoutMs;
  document.body.classList.toggle('reduce-motion', !settings.ambientMotion);
  document.body.classList.toggle('large-text', settings.largeText);

  if (settingAutoListen)        settingAutoListen.checked        = settings.autoListen;
  if (settingBargeIn)           settingBargeIn.checked           = settings.bargeIn;
  if (settingAutoListenTimeout) settingAutoListenTimeout.value   = String(settings.autoListenTimeoutMs);
  if (settingAmbientMotion)     settingAmbientMotion.checked     = settings.ambientMotion;
  if (settingLargeText)         settingLargeText.checked         = settings.largeText;
  if (settingTtsEnabled)        settingTtsEnabled.checked        = settings.ttsEnabled;

  // Notify host of updated audio preference
  if (ws && ws.readyState === WebSocket.OPEN) {
    send('client_hello', { role: 'display', canReceiveAudio: settings.ttsEnabled });
  }

  updateDashboard();
}

function bindSetting(el, key, transform) {
  if (!el) return;
  el.addEventListener('change', () => {
    settings[key] = transform ? transform(el) : el.checked;
    saveSettings();
    applySettings();
  });
}

// ---- Events ----

// PTT mic button — unified pointer events (desktop + touch)
btnPTT.addEventListener('contextmenu', (e) => e.preventDefault());

function handlePtrDown(e) {
  e.preventDefault();
  if (activePointerId !== null) return;
  activePointerId = e.pointerId;
  try { btnPTT.setPointerCapture(e.pointerId); } catch {}

  if (['speaking', 'working', 'thinking'].includes(currentState)) {
    interruptClive();
    voiceMode = true;
    manualPTT = true;
    setTimeout(() => { if (!isRecording) startRecording(false); }, 50);
    return;
  }
  if (!canUseBrowserMic()) return;
  if (isAutoListening) stopAutoListen(false);
  voiceMode = true;
  manualPTT = true;
  startRecording(false);
}

function handlePtrUp(e) {
  e.preventDefault();
  if (activePointerId === e.pointerId) {
    activePointerId = null;
    try { btnPTT.releasePointerCapture(e.pointerId); } catch {}
    if (manualPTT) { manualPTT = false; stopRecording(); }
  }
}

btnPTT.addEventListener('pointerdown', handlePtrDown);
btnPTT.addEventListener('pointerup',   handlePtrUp);
btnPTT.addEventListener('pointercancel', handlePtrUp);
btnPTT.addEventListener('pointerleave',  handlePtrUp);

// Voice overlay cancel
btnVoiceCancel.addEventListener('click', () => {
  interruptClive();
  voiceMode = false;
});

// Text input
if (textInput) {
  textInput.addEventListener('input', () => {
    btnTextSend.classList.toggle('visible', textInput.value.trim().length > 0);
  });
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitTextInput(); }
  });
}
if (btnTextSend) {
  btnTextSend.addEventListener('click', submitTextInput);
}

// Confirmation
btnConfirm.addEventListener('click', () => { send('confirmation_response', { confirmed: true });  confirmation.classList.add('hidden'); });
btnDeny.addEventListener('click',    () => { send('confirmation_response', { confirmed: false }); confirmation.classList.add('hidden'); });

// Settings
btnSettings.addEventListener('click', openSettings);
btnCloseSettings.addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', closeSettings);

bindSetting(settingAutoListen,        'autoListen');
bindSetting(settingBargeIn,           'bargeIn');
bindSetting(settingAutoListenTimeout, 'autoListenTimeoutMs', (el) => parseInt(el.value, 10));
bindSetting(settingAmbientMotion,     'ambientMotion');
bindSetting(settingLargeText,         'largeText');
bindSetting(settingTtsEnabled,        'ttsEnabled');

if (btnExitKiosk) {
  btnExitKiosk.addEventListener('click', async () => {
    try { await fetch('/api/exit-kiosk', { method: 'POST' }); }
    catch (err) { console.warn('Failed to exit kiosk:', err); }
  });
}

window.addEventListener('resize', updateDashboard);

// ---- Init ----

applySettings();
setState('idle');
updateClock();
setInterval(updateClock, 30000);
refreshHostStatus();
setInterval(refreshHostStatus, 1500);
connect();
