/**
 * Clive UI — Responsive companion interface
 * WebSocket, audio capture/playback, VAD, auto-listen, barge-in,
 * conversation history, settings persistence, sidebar toggle.
 */

const CLIVE_CONFIG = window.CLIVE_CONFIG || {};
const WS_URL = CLIVE_CONFIG.hostWsUrl || `ws://${location.hostname || 'localhost'}:3100`;
const STATUS_URL = `${(CLIVE_CONFIG.hostHttpUrl || `http://${location.hostname || 'localhost'}:3100`).replace(/\/$/, '')}/api/status`;

// ---- DOM refs ----

const app = document.getElementById('app');
const stateLabel = document.getElementById('state-label');
const heroBadge = document.getElementById('hero-badge');
const clockDisplay = document.getElementById('clock-display');
const connectionText = document.getElementById('connection-text');
const connectionDot = document.getElementById('connection-dot');
const historyEl = document.getElementById('history');
const historySection = document.getElementById('history-section');
const transcript = document.getElementById('transcript');
const response = document.getElementById('response');
const taskStatus = document.getElementById('task-status');
const taskLabel = document.getElementById('task-label');
const taskProgress = document.getElementById('task-progress');
const confirmation = document.getElementById('confirmation');
const confirmMessage = document.getElementById('confirm-message');
const btnConfirm = document.getElementById('btn-confirm');
const btnDeny = document.getElementById('btn-deny');
const interactionHint = document.getElementById('interaction-hint');
const btnPTT = document.getElementById('btn-push-to-talk');
const btnPTTLabel = btnPTT.querySelector('.ptt-label');
const btnStatusToggle = document.getElementById('btn-status-toggle');
const btnSettings = document.getElementById('btn-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const settingsPanel = document.getElementById('settings-panel');
const settingsBackdrop = document.getElementById('settings-backdrop');
const sidebar = document.getElementById('sidebar');

// Dashboard elements
const metricMode = document.getElementById('metric-mode');
const metricWakeWord = document.getElementById('metric-wake-word');
const metricAudio = document.getElementById('metric-audio');
const metricDevice = document.getElementById('metric-device');
const hostBridgeMode = document.getElementById('host-bridge-mode');
const hostAgentId = document.getElementById('host-agent-id');
const hostAgentHealth = document.getElementById('host-agent-health');
const hostLastTranscript = document.getElementById('host-last-transcript');
const notePrimary = document.getElementById('note-primary');
const noteSecondary = document.getElementById('note-secondary');
const noteTertiary = document.getElementById('note-tertiary');
const previewAutoListen = document.getElementById('preview-auto-listen');
const previewBargeIn = document.getElementById('preview-barge-in');
const previewAutoTimeout = document.getElementById('preview-auto-timeout');
const previewAmbientMotion = document.getElementById('preview-ambient-motion');
const previewLargeText = document.getElementById('preview-large-text');
const settingAutoListen = document.getElementById('setting-auto-listen');
const settingBargeIn = document.getElementById('setting-barge-in');
const settingAutoListenTimeout = document.getElementById('setting-auto-listen-timeout');
const settingAmbientMotion = document.getElementById('setting-ambient-motion');
const settingCompactMode = document.getElementById('setting-compact-mode');
const settingShowHistory = document.getElementById('setting-show-history');
const settingLargeText = document.getElementById('setting-large-text');
const btnExitKiosk = document.getElementById('btn-exit-kiosk');

// ---- State ----

let ws = null;
let currentState = 'idle';
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

// Conversation
let conversationHistory = [];
const MAX_HISTORY = 4;
let currentTranscript = '';
let currentResponse = '';

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

// Settings
const SETTINGS_KEY = 'clive_dashboard_settings_v1';

function loadSettings() {
  const defaults = {
    autoListen: true,
    autoListenTimeoutMs: 5000,
    bargeIn: true,
    ambientMotion: true,
    compactMode: false,
    showHistory: true,
    largeText: false,
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
    send('client_hello', { role: 'display', canReceiveAudio: true });
    connectionDot.classList.add('connected');
    connectionText.textContent = 'Connected';
    updateDashboard();
  };

  ws.onclose = () => {
    connectionDot.classList.remove('connected');
    connectionText.textContent = 'Reconnecting';
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
    case 'state_change': setState(msg.payload.state); break;
    case 'transcript': showTranscript(msg.payload.text); break;
    case 'response_text': showResponse(msg.payload.text, msg.payload.streaming); break;
    case 'response_audio_end':
      serverAudioEnded = true;
      if (!isPlaybackActive()) onAudioPlaybackDone();
      break;
    case 'response_display': showDisplayCard(msg.payload.text, msg.payload.summary); break;
    case 'task_status': showTaskStatus(msg.payload.label, msg.payload.progress); break;
    case 'confirmation_request': showConfirmation(msg.payload.message); break;
    case 'error': showError(msg.payload.error); break;
  }
}

function handleAudioChunk(buffer) {
  serverAudioEnded = false;
  audioQueue.push(buffer);
  if (!isPlaying) playNextChunk();
}

// ---- State Machine ----

const stateLabels = {
  idle: 'ready',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  working: 'working',
  confirming: 'confirm',
  error: 'error',
};

function setState(newState) {
  if (newState === 'idle' && isPlaybackActive()) {
    deferredState = 'idle';
    updatePTTButton('speaking');
    return;
  }

  if (currentState === newState) return;
  const prevState = currentState;

  app.className = `state-${newState}`;
  stateLabel.textContent = stateLabels[newState] || newState;

  if (newState === 'listening') {
    confirmation.classList.add('hidden');
    taskStatus.classList.add('hidden');
    btnPTT.classList.add('recording');
  }

  if (prevState === 'listening') {
    btnPTT.classList.remove('recording');
  }

  updatePTTButton(newState);

  if (newState === 'idle' && (prevState === 'speaking' || prevState === 'working')) {
    if (currentTranscript && currentResponse) {
      addToHistory(currentTranscript, currentResponse);
    }
    setTimeout(() => {
      if (currentState === 'idle') {
        response.textContent = '';
        transcript.classList.add('hidden');
        taskStatus.classList.add('hidden');
      }
    }, 8000);
  }

  if (newState === 'error') {
    setTimeout(() => { if (currentState === 'error') setState('idle'); }, 5000);
  }

  currentState = newState;
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
    await startRecording(true);
    vadNoSpeechTimer = setTimeout(() => {
      if (isAutoListening && !vadSpeechDetected) stopAutoListen(false);
    }, autoListenNoSpeechTimeout);
  } catch (e) {
    console.error('[AutoListen] Failed:', e);
    isAutoListening = false;
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

// ---- Conversation History ----

function addToHistory(userText, cliveText) {
  conversationHistory.push({ user: userText, clive: cliveText });
  if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();
  renderHistory();
}

function renderHistory() {
  historyEl.innerHTML = conversationHistory.map(entry => `
    <div class="history-entry">
      <div class="history-user">${esc(entry.user)}</div>
      <div class="history-clive">${esc(entry.clive)}</div>
    </div>
  `).join('');
  historyEl.scrollTop = historyEl.scrollHeight;
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ---- UI Updates ----

function showTranscript(text) {
  const card = document.getElementById('display-card');
  if (card) card.classList.add('hidden');
  currentTranscript = text;
  transcript.textContent = text;
  transcript.classList.remove('hidden');
  updateDashboard();
}

function showResponse(text, streaming = false) {
  if (streaming) { currentResponse += text; response.textContent = currentResponse; }
  else { currentResponse = text; response.textContent = text; }
  updateDashboard();
}

function showTaskStatus(label, progress) {
  taskLabel.textContent = label;
  const p = (progress || '').trim();
  const t = (currentTranscript || '').trim();
  taskProgress.textContent = (p && p !== t) ? progress : '';
  taskStatus.classList.remove('hidden');
  updateDashboard();
}

function showConfirmation(message) {
  confirmMessage.textContent = message;
  confirmation.classList.remove('hidden');
}

/**
 * Show a formatted display card for long/listy content.
 * Clive speaks a brief summary but shows the full content here.
 */
function showDisplayCard(fullText, summary) {
  // Replace the plain response text with the summary
  currentResponse = summary || fullText;
  response.textContent = summary || '';

  const card = document.getElementById('display-card');
  const cardBody = document.getElementById('display-card-body');
  if (!card || !cardBody) return;

  // Format the text: convert markdown-ish content to readable HTML
  cardBody.innerHTML = formatDisplayContent(fullText);
  card.classList.remove('hidden');
  card.scrollTop = 0;
  requestAnimationFrame(() => {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // Store the full text for history
  currentResponse = summary || fullText.substring(0, 120) + '...';
}

/**
 * Convert markdown-ish text into clean HTML for the display card.
 */
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

    // Images: ![alt](url)
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<img src="${imgMatch[2]}" alt="${esc(imgMatch[1])}" class="dc-image" loading="lazy" />`;
      continue;
    }

    // Bold headers: **Section Name**
    if (/^\*\*(.+?)\*\*/.test(trimmed)) {
      if (inList) { html += '</ul>'; inList = false; }
      const title = trimmed.replace(/\*\*(.+?)\*\*/g, '$1').replace(/[-–]$/, '').trim();
      html += `<div class="dc-section">${esc(title)}</div>`;
      continue;
    }

    // List items: - item, * item, • item, 1. item
    const listMatch = trimmed.match(/^\s*[-*•]\s+(.+)/) || trimmed.match(/^\s*\d+[.)]\s+(.+)/);
    if (listMatch) {
      if (!inList) { html += '<ul class="dc-list">'; inList = true; }
      // Handle inline backticks
      const content = listMatch[1].replace(/`([^`]+)`/g, '<code>$1</code>');
      html += `<li>${content}</li>`;
      continue;
    }

    // Regular paragraph
    if (inList) { html += '</ul>'; inList = false; }
    html += `<p class="dc-para">${esc(trimmed)}</p>`;
  }

  if (inList) html += '</ul>';
  return html;
}

function showError(error) {
  setState('error');
  response.textContent = error;
  const card = document.getElementById('display-card');
  if (card) card.classList.add('hidden');
  updateDashboard();
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
  return true; // Always allow browser mic for manual PTT.
}

function releaseBrowserMic() {
  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor = null;
  }
  if (passiveMonitorProcessor) {
    passiveMonitorProcessor.disconnect();
    passiveMonitorProcessor = null;
  }
  if (passiveMonitorSink) {
    passiveMonitorSink.disconnect();
    passiveMonitorSink = null;
  }
  if (mediaSource) {
    mediaSource.disconnect();
    mediaSource = null;
  }
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
  if (!canUseBrowserMic()) {
    micAvailable = false;
    updateDashboard();
    return;
  }
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
    if (pendingStopAfterStart) {
      pendingStopAfterStart = false;
      stopRecording();
    }
  } catch (e) {
    console.error('[Audio] Capture error:', e);
    micAvailable = false;
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
  if (isStartingRecording && !isRecording) {
    pendingStopAfterStart = true;
    return;
  }
  if (!isRecording) return;
  isRecording = false;
  clearVADTimers();
  isAutoListening = false;
  manualPTT = false;
  if (audioProcessor) { audioProcessor.disconnect(); audioProcessor = null; }
  send('press_to_talk_end');
}

function cancelRecording() {
  if (isStartingRecording && !isRecording) {
    pendingStopAfterStart = false;
    isStartingRecording = false;
    return;
  }
  if (!isRecording) return;
  isRecording = false;
  clearVADTimers();
  isAutoListening = false;
  manualPTT = false;
  if (audioProcessor) { audioProcessor.disconnect(); audioProcessor = null; }
  send('cancel');
  setState('idle');
}

function simulateInteraction() {
  send('press_to_talk_start');
  setTimeout(() => send('press_to_talk_end'), 800);
}

// ---- Helpers ----

function send(type, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
}

function updatePTTButton(state = currentState) {
  const interrupt = ['speaking', 'working', 'thinking'].includes(state);
  btnPTT.disabled = false;
  btnPTTLabel.textContent = interrupt ? 'Interrupt' : 'Hold to Talk';
  if (interactionHint) {
    interactionHint.textContent = listenerConnected
      ? 'Auto-listen is off because the Python listener is active. Hold to talk manually.'
      : 'Hold to talk, or interrupt when Clive is speaking.';
  }
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
  send('cancel');
  setState('idle');
}

// ---- Dashboard ----

function updateClock() {
  if (clockDisplay) clockDisplay.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function getDeviceLabel() {
  const w = window.innerWidth;
  if (w <= 600) return 'Phone';
  if (w <= 960) return 'Tablet';
  return 'Desktop';
}

function updateDashboard() {
  updatePTTButton();
  if (metricMode) metricMode.textContent = stateLabels[currentState] || currentState;
  if (metricWakeWord) metricWakeWord.textContent = listenerConnected ? 'Listener online' : 'Browser fallback';
  if (metricAudio) {
    metricAudio.textContent = listenerConnected
      ? 'Listener'
      : micAvailable ? (isRecording ? 'Listening' : isStartingRecording ? 'Arming' : 'Ready') : 'Blocked';
  }
  if (metricDevice) metricDevice.textContent = getDeviceLabel();

  if (heroBadge) {
    const label = stateLabels[currentState] || currentState;
    heroBadge.textContent = label.charAt(0).toUpperCase() + label.slice(1);
  }

  if (notePrimary) {
    notePrimary.textContent = isAutoListening
      ? `Listening for reply (${Math.round(autoListenNoSpeechTimeout / 1000)}s timeout)...`
      : isStartingRecording ? 'Opening the mic...'
      : currentState === 'idle' ? 'Clive is ready for voice input.'
      : currentState === 'speaking' ? 'Clive is speaking. Interrupt by button or voice.'
      : 'Handling current request...';
  }

  if (noteSecondary) {
    noteSecondary.textContent = listenerConnected
      ? 'Dedicated listener owns the microphone.'
      : 'Browser microphone fallback is active.';
  }

  if (noteTertiary) {
    noteTertiary.textContent = listenerConnected
      ? 'Wake word and VAD are handled by the Python listener.'
      : settings.bargeIn
        ? 'Speech barge-in is enabled.'
        : 'Barge-in is disabled in settings.';
  }

  if (lastHostStatus) {
    if (hostBridgeMode) hostBridgeMode.textContent = lastHostStatus.agent?.mode === 'gateway-http' ? 'Gateway HTTP' : 'Mock';
    if (hostAgentId) hostAgentId.textContent = lastHostStatus.agent?.agentId || 'Unknown';
    if (hostAgentHealth) hostAgentHealth.textContent = lastHostStatus.agent?.healthy ? 'Healthy' : 'Degraded';
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
  return text.slice(0, max - 1) + '...';
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
  document.body.classList.toggle('compact-mode', settings.compactMode);
  document.body.classList.toggle('reduce-motion', !settings.ambientMotion);
  document.body.classList.toggle('large-text', settings.largeText);
  if (historySection) historySection.classList.toggle('hidden', !settings.showHistory);

  // Sync form controls
  if (settingAutoListen) settingAutoListen.checked = settings.autoListen;
  if (settingBargeIn) settingBargeIn.checked = settings.bargeIn;
  if (settingAutoListenTimeout) settingAutoListenTimeout.value = String(settings.autoListenTimeoutMs);
  if (settingAmbientMotion) settingAmbientMotion.checked = settings.ambientMotion;
  if (settingCompactMode) settingCompactMode.checked = settings.compactMode;
  if (settingShowHistory) settingShowHistory.checked = settings.showHistory;
  if (settingLargeText) settingLargeText.checked = settings.largeText;

  // Sync preview
  if (previewAutoListen) previewAutoListen.textContent = settings.autoListen ? 'On' : 'Off';
  if (previewBargeIn) previewBargeIn.textContent = settings.bargeIn ? 'On' : 'Off';
  if (previewAutoTimeout) previewAutoTimeout.textContent = `${Math.round(settings.autoListenTimeoutMs / 1000)}s`;
  if (previewAmbientMotion) previewAmbientMotion.textContent = settings.ambientMotion ? 'On' : 'Off';
  if (previewLargeText) previewLargeText.textContent = settings.largeText ? 'Large' : 'Standard';

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

// ---- Sidebar toggle ----

function toggleSidebar() {
  sidebar.classList.toggle('collapsed');
}

// ---- Events ----

// PTT — unified pointer events (desktop + mobile)
btnPTT.addEventListener('contextmenu', (e) => e.preventDefault());

function handlePtrDown(e) {
  e.preventDefault();
  if (['speaking', 'working', 'thinking'].includes(currentState)) {
    interruptClive();
    manualPTT = true;
    setTimeout(() => { if (!isRecording) startRecording(false); }, 50);
    return;
  }
  if (!canUseBrowserMic()) return;
  if (isAutoListening) stopAutoListen(false);
  manualPTT = true;
  startRecording(false);
}

function handlePtrUp(e) {
  e.preventDefault();
  if (manualPTT) { manualPTT = false; stopRecording(); }
}

btnPTT.addEventListener('pointerdown', handlePtrDown);
btnPTT.addEventListener('pointerup', handlePtrUp);
btnPTT.addEventListener('pointercancel', handlePtrUp);
btnPTT.addEventListener('pointerleave', handlePtrUp);

// Confirm
btnConfirm.addEventListener('click', () => { send('confirmation_response', { confirmed: true }); confirmation.classList.add('hidden'); });
btnDeny.addEventListener('click', () => { send('confirmation_response', { confirmed: false }); confirmation.classList.add('hidden'); });

// Sidebar & settings
btnStatusToggle.addEventListener('click', toggleSidebar);
btnSettings.addEventListener('click', openSettings);
btnCloseSettings.addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', closeSettings);

// Bind settings controls
bindSetting(settingAutoListen, 'autoListen');
bindSetting(settingBargeIn, 'bargeIn');
bindSetting(settingAutoListenTimeout, 'autoListenTimeoutMs', (el) => parseInt(el.value, 10));
bindSetting(settingAmbientMotion, 'ambientMotion');
bindSetting(settingCompactMode, 'compactMode');
bindSetting(settingShowHistory, 'showHistory');
bindSetting(settingLargeText, 'largeText');

if (btnExitKiosk) {
  btnExitKiosk.addEventListener('click', async () => {
    try { await fetch('/api/exit-kiosk', { method: 'POST' }); }
    catch (err) { console.warn('Failed to exit kiosk mode:', err); }
  });
}

window.addEventListener('resize', updateDashboard);

// ---- Init ----

applySettings();
setState('idle');
updatePTTButton('idle');
updateClock();
setInterval(updateClock, 30000);
refreshHostStatus();
setInterval(refreshHostStatus, 1500);
connect();

// Default sidebar: open on desktop, closed on mobile
if (window.innerWidth > 960) sidebar.classList.remove('collapsed');
