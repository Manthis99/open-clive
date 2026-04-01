/**
 * Personality Engine — Clive's character layer.
 *
 * Two responsibilities:
 * 1. Classify intent (conversation vs action)
 * 2. Generate personality-shaped responses
 */

const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT_PATH = path.join(__dirname, '../../../shared/personality/system-prompt.txt');
const SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLIVE_MODEL || 'claude-sonnet-4-6';

const USE_MOCK = !API_KEY || process.env.MOCK_LLM === '1' || process.env.MOCK_LLM === 'true';

if (USE_MOCK) {
  console.log('[Personality] Mock mode — no API key');
} else {
  console.log(`[Personality] Using ${MODEL}`);
}

// Conversation history
const conversationHistory = [];
const MAX_HISTORY = 10;

// ---- Intent Classification ----

const INTENT_PROMPT = `You are an intent classifier for a voice assistant named Clive that can control the user's computer through an agent called OpenClaw.

Classify the user's message into exactly one of these categories:
- "action" — the user wants you to DO something on their computer (open apps, search the web, manage files, send messages, check something, run commands, control the browser, etc.)
- "conversation" — the user is talking, asking questions, making observations, or wants a verbal response only

Respond with ONLY a JSON object: {"intent": "action"} or {"intent": "conversation"}

Examples:
"open my browser" → {"intent": "action"}
"what time is it" → {"intent": "action"}
"search for flights to Tokyo" → {"intent": "action"}
"close all my tabs" → {"intent": "action"}
"send a message to Sarah" → {"intent": "action"}
"what's the weather" → {"intent": "action"}
"how are you" → {"intent": "conversation"}
"tell me a joke" → {"intent": "conversation"}
"what can you do" → {"intent": "conversation"}
"who are you" → {"intent": "conversation"}
"thanks" → {"intent": "conversation"}
"never mind" → {"intent": "conversation"}`;

/**
 * Classify whether user input is a task (action) or just conversation.
 * Returns { intent: 'action' | 'conversation' }
 */
async function classifyIntent(userInput) {
  if (USE_MOCK) {
    return mockClassify(userInput);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Fast + cheap for classification
        max_tokens: 30,
        system: INTENT_PROMPT,
        messages: [{ role: 'user', content: userInput }],
      }),
    });

    if (!response.ok) {
      console.error('[Personality] Intent classification failed, defaulting to conversation');
      return { intent: 'conversation' };
    }

    const data = await response.json();
    const text = data.content[0].text.trim();

    try {
      const parsed = JSON.parse(text);
      console.log(`[Personality] Intent: ${parsed.intent}`);
      return parsed;
    } catch {
      // Try to extract intent from text
      if (text.includes('action')) return { intent: 'action' };
      return { intent: 'conversation' };
    }
  } catch (e) {
    console.error('[Personality] Classification error:', e.message);
    return { intent: 'conversation' };
  }
}

// ---- Response Generation ----

/**
 * Get a personality-shaped conversational response.
 */
async function getResponse(userInput) {
  if (USE_MOCK) {
    return mockResponse(userInput);
  }

  conversationHistory.push({ role: 'user', content: userInput });
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        system: SYSTEM_PROMPT,
        messages: conversationHistory,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const assistantMessage = data.content[0].text;
    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    return assistantMessage;
  } catch (e) {
    console.error('[Personality] Error:', e.message);
    return "Something went wrong on my end. Try again?";
  }
}

/**
 * Shape an OpenClaw result into Clive's voice.
 * Takes the raw agent output and makes it sound like Clive.
 */
async function shapeAgentResponse(userRequest, agentResult) {
  if (USE_MOCK) {
    return agentResult;
  }

  const shapePrompt = SYSTEM_PROMPT + `\n\nYou just completed a task for the user using your computer control capabilities. The user asked: "${userRequest}"\n\nThe task result was: "${agentResult}"\n\nNow respond to the user briefly, in your voice. Summarize what happened in 1-2 sentences. Don't repeat the full result — just confirm what was done or relay the key information.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 150,
        system: shapePrompt,
        messages: [{ role: 'user', content: 'What happened?' }],
      }),
    });

    if (!response.ok) return agentResult;

    const data = await response.json();
    return data.content[0].text;
  } catch {
    return agentResult;
  }
}

// ---- Mock ----

function mockClassify(input) {
  const lower = input.toLowerCase();
  const actionWords = ['open', 'close', 'search', 'find', 'send', 'check', 'run', 'show', 'play', 'stop', 'create', 'delete', 'move', 'copy'];
  const isAction = actionWords.some(w => lower.includes(w));
  return { intent: isAction ? 'action' : 'conversation' };
}

function mockResponse(input) {
  const lower = input.toLowerCase();
  if (lower.includes('time')) return "I don't have a clock in mock mode.";
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) return "I'm here.";
  if (lower.includes('who') || lower.includes('what are you')) return "I'm Clive. I sit on your desk and handle things.";
  const defaults = ["Got it.", "One moment.", "Alright.", "I'll handle it."];
  return defaults[Math.floor(Math.random() * defaults.length)];
}

module.exports = { classifyIntent, getResponse, shapeAgentResponse };
