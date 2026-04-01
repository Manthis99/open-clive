/**
 * Response Shaper
 *
 * Analyzes the LLM response text and conversation context to produce
 * metadata that shapes how TTS renders the speech.
 *
 * This is a bridge layer between raw text generation and context-aware
 * speech rendering. Even without CSM, it helps the pipeline make better
 * decisions about pacing, energy, and delivery.
 *
 * Output metadata:
 *   - brevity: 'short' | 'medium' | 'long'
 *   - energy: 'low' | 'medium' | 'high'
 *   - tone: 'serious' | 'playful' | 'warm' | 'neutral' | 'firm'
 *   - interruptible: boolean (should delivery favor natural pause points?)
 *   - speakingRate: number (multiplier, 0.8 = slower, 1.2 = faster)
 */

const { getConversationState } = require('./conversation-buffer');

/**
 * Shape a response for TTS delivery.
 *
 * @param {string} responseText - The text Clive will speak
 * @param {string} userText - What the user said (for context)
 * @returns {object} Response metadata
 */
function shapeResponse(responseText, userText = '') {
  const convState = getConversationState();

  const brevity = inferBrevity(responseText);
  const energy = inferEnergy(responseText, userText, convState);
  const tone = inferTone(responseText, userText);
  const interruptible = brevity !== 'short' || convState.conversationEnergy === 'high';
  const speakingRate = inferSpeakingRate(brevity, energy, convState);

  return {
    brevity,
    energy,
    tone,
    interruptible,
    speakingRate,
  };
}

// ---- Inference Functions ----

function inferBrevity(text) {
  const wordCount = text.split(/\s+/).length;
  if (wordCount <= 8) return 'short';
  if (wordCount <= 30) return 'medium';
  return 'long';
}

function inferEnergy(responseText, userText, convState) {
  // High energy: rapid back-and-forth, exclamation marks, questions
  if (convState.conversationEnergy === 'high') return 'high';

  const hasExclamation = responseText.includes('!');
  const hasQuestion = responseText.includes('?');
  const userHadQuestion = userText.includes('?');

  if (hasExclamation || (hasQuestion && userHadQuestion)) return 'high';

  // Low energy: returning after silence, contemplative content
  if (convState.timeSinceLastTurn > 120000) return 'low'; // 2+ minutes since last turn

  return 'medium';
}

function inferTone(responseText, userText) {
  const lower = responseText.toLowerCase();

  // Check for serious/firm signals
  const seriousPatterns = [
    /\bno[,.]?\s/,
    /\bi disagree\b/,
    /\bthat's (wrong|not right|incorrect)\b/,
    /\bcareful\b/,
    /\bwarning\b/,
    /\bdon't\b.*\bthink\b/,
  ];

  for (const pattern of seriousPatterns) {
    if (pattern.test(lower)) return 'firm';
  }

  // Check for warmth signals
  const warmPatterns = [
    /\bgood (work|job|thinking|call)\b/,
    /\bnice\b/,
    /\bwell done\b/,
    /\bthat's (right|good|excellent|brilliant)\b/,
    /\bi like\b/,
  ];

  for (const pattern of warmPatterns) {
    if (pattern.test(lower)) return 'warm';
  }

  // Check for playful signals
  const playfulPatterns = [
    /\bheh\b/,
    /\bha\b/,
    /\bfunny\b/,
    /\bjoke\b/,
    /\bironic\b/,
    /;/,
  ];

  for (const pattern of playfulPatterns) {
    if (pattern.test(lower)) return 'playful';
  }

  // Check for serious content
  if (lower.includes('important') || lower.includes('careful') || lower.includes('risk')) {
    return 'serious';
  }

  return 'neutral';
}

function inferSpeakingRate(brevity, energy, convState) {
  let rate = 1.0;

  // Short responses should feel snappy
  if (brevity === 'short') rate += 0.1;

  // High energy conversations get slightly faster pacing
  if (energy === 'high') rate += 0.1;

  // Returning after silence should be measured, not rushed
  if (convState.timeSinceLastTurn > 120000) rate -= 0.1;

  // Long responses should pace slightly slower for clarity
  if (brevity === 'long') rate -= 0.05;

  // Clamp to reasonable range
  return Math.max(0.8, Math.min(1.3, rate));
}

module.exports = { shapeResponse };
