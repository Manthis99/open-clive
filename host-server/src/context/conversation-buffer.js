/**
 * Rolling Conversation Context Buffer
 *
 * Maintains a sliding window of recent conversational turns, each with:
 *   - speaker (0 = Clive, 1 = user)
 *   - transcript/response text
 *   - path to saved audio file (for CSM context feeding)
 *   - timestamp and inferred metadata
 *
 * This buffer serves two purposes:
 *   1. Feed CSM's context parameter with recent Segment objects
 *   2. Track conversational state for response shaping
 *
 * Audio files are saved to a temp directory and automatically cleaned up.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONTEXT_DIR = path.join(os.tmpdir(), 'clive-context-audio');
const MAX_TURNS = parseInt(process.env.CSM_MAX_CONTEXT_TURNS || '10', 10);
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// Speaker constants
const SPEAKER_CLIVE = 0;
const SPEAKER_USER = 1;

// ---- State ----

const turns = [];

// Ensure context audio directory exists
try {
  if (!fs.existsSync(CONTEXT_DIR)) {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  }
} catch (e) {
  console.error('[Context] Failed to create context audio dir:', e.message);
}

// ---- Public API ----

/**
 * Add a turn to the conversation buffer.
 *
 * @param {number} speaker - SPEAKER_CLIVE (0) or SPEAKER_USER (1)
 * @param {string} text - Transcript or response text
 * @param {Buffer|null} audioData - Raw audio data (WAV) to save for CSM context
 * @param {object} metadata - Optional metadata { mood, energy, brevity }
 * @returns {object} The created turn record
 */
function addTurn(speaker, text, audioData = null, metadata = {}) {
  let audioPath = null;

  // Save audio to temp file if provided
  if (audioData && audioData.length > 0) {
    try {
      const filename = `turn_${Date.now()}_s${speaker}.wav`;
      audioPath = path.join(CONTEXT_DIR, filename);
      fs.writeFileSync(audioPath, audioData);
    } catch (e) {
      console.error('[Context] Failed to save audio:', e.message);
      audioPath = null;
    }
  }

  const turn = {
    speaker,
    text: text || '',
    audioPath,
    timestamp: Date.now(),
    mood: metadata.mood || null,
    energy: metadata.energy || null,
    brevity: metadata.brevity || null,
  };

  turns.push(turn);

  // Enforce max size
  while (turns.length > MAX_TURNS) {
    const removed = turns.shift();
    cleanupTurnAudio(removed);
  }

  // Clean expired turns
  cleanupExpiredTurns();

  return turn;
}

/**
 * Get recent turns for CSM context feeding.
 *
 * @param {number} count - Number of recent turns to return (default: 5)
 * @returns {Array} Array of turn objects with { text, speaker, audioPath }
 */
function getRecentTurns(count = 5) {
  cleanupExpiredTurns();
  return turns.slice(-count).map(t => ({
    text: t.text,
    speaker: t.speaker,
    audioPath: t.audioPath && fs.existsSync(t.audioPath) ? t.audioPath : null,
    timestamp: t.timestamp,
  }));
}

/**
 * Get the full conversation buffer (for debugging/status).
 */
function getAllTurns() {
  return [...turns];
}

/**
 * Get conversation metadata for response shaping.
 */
function getConversationState() {
  if (turns.length === 0) {
    return {
      turnCount: 0,
      lastSpeaker: null,
      timeSinceLastTurn: Infinity,
      recentUserTurnCount: 0,
      conversationEnergy: 'low',
    };
  }

  const now = Date.now();
  const lastTurn = turns[turns.length - 1];
  const recentWindow = 60000; // Last 60 seconds

  const recentTurns = turns.filter(t => now - t.timestamp < recentWindow);
  const recentUserTurns = recentTurns.filter(t => t.speaker === SPEAKER_USER);

  // Infer conversational energy from turn frequency
  let energy = 'low';
  if (recentUserTurns.length >= 4) energy = 'high';
  else if (recentUserTurns.length >= 2) energy = 'medium';

  return {
    turnCount: turns.length,
    lastSpeaker: lastTurn.speaker,
    timeSinceLastTurn: now - lastTurn.timestamp,
    recentUserTurnCount: recentUserTurns.length,
    conversationEnergy: energy,
  };
}

/**
 * Clear all turns and clean up audio files.
 */
function clearBuffer() {
  for (const turn of turns) {
    cleanupTurnAudio(turn);
  }
  turns.length = 0;
}

// ---- Internal ----

function cleanupExpiredTurns() {
  const now = Date.now();
  while (turns.length > 0 && now - turns[0].timestamp > MAX_AGE_MS) {
    const removed = turns.shift();
    cleanupTurnAudio(removed);
  }
}

function cleanupTurnAudio(turn) {
  if (turn.audioPath) {
    try {
      if (fs.existsSync(turn.audioPath)) {
        fs.unlinkSync(turn.audioPath);
      }
    } catch {}
  }
}

/**
 * Clean up the entire context audio directory.
 */
function cleanupAll() {
  clearBuffer();
  try {
    const files = fs.readdirSync(CONTEXT_DIR);
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(CONTEXT_DIR, file));
      } catch {}
    }
  } catch {}
}

module.exports = {
  SPEAKER_CLIVE,
  SPEAKER_USER,
  addTurn,
  getRecentTurns,
  getAllTurns,
  getConversationState,
  clearBuffer,
  cleanupAll,
};
