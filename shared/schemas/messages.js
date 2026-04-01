/**
 * WebSocket message protocol between Pi client and Host server.
 * All messages are JSON with { type, payload, timestamp }.
 */

// Message types
const MessageType = {
  // Pi/Desktop -> Host
  WAKE_WORD_DETECTED: 'wake_word_detected',
  AUDIO_CHUNK: 'audio_chunk',
  AUDIO_END: 'audio_end',
  PRESS_TO_TALK_START: 'press_to_talk_start',
  PRESS_TO_TALK_END: 'press_to_talk_end',
  CONFIRMATION_RESPONSE: 'confirmation_response',
  CANCEL: 'cancel',
  BARGE_IN: 'barge_in',

  // Host -> Pi/Desktop
  STATE_CHANGE: 'state_change',
  RESPONSE_DISPLAY: 'response_display',
  TRANSCRIPT: 'transcript',
  RESPONSE_TEXT: 'response_text',
  RESPONSE_AUDIO_CHUNK: 'response_audio_chunk',
  RESPONSE_AUDIO_END: 'response_audio_end',
  TASK_STATUS: 'task_status',
  CONFIRMATION_REQUEST: 'confirmation_request',
  ERROR: 'error',
};

// Clive's visual/interaction states
const CliveState = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  WORKING: 'working',
  CONFIRMING: 'confirming',
  ERROR: 'error',
};

function createMessage(type, payload = {}) {
  return JSON.stringify({
    type,
    payload,
    timestamp: Date.now(),
  });
}

function parseMessage(data) {
  try {
    const msg = JSON.parse(data);
    if (!msg.type) throw new Error('Missing message type');
    return msg;
  } catch (e) {
    return { type: MessageType.ERROR, payload: { error: e.message }, timestamp: Date.now() };
  }
}

module.exports = { MessageType, CliveState, createMessage, parseMessage };
