# Sesame CSM Architecture Roadmap For Clive

## Why This Exists

This note captures how Sesame's CSM work should influence Clive's long-term architecture.

The important lesson is not merely "use a better voice model." The lesson is that voice presence comes from **context-aware speech**, not just natural-sounding audio.

Clive should eventually feel like:

- the same person across time
- aware of the immediate conversational moment
- capable of natural timing, interruption, and emotional fit
- voiced in a way that reflects context, not just text

## What Sesame CSM Actually Is

Sesame CSM is **not** a general assistant framework.

It is a conversational speech generation model that:

- takes text input
- takes previous conversational segments as context
- uses both transcript and audio context
- generates new speech audio for the next turn

It does **not** generate the words themselves. A separate LLM is still required.

## What This Means For Clive

Clive should remain split into distinct layers:

1. **Mind**
   - OpenClaw
   - memory
   - soul / identity
   - reasoning
   - tool use
   - long-term continuity

2. **Conversation Brain**
   - turn management
   - interruption logic
   - barge-in
   - reply timing
   - short rolling conversation state
   - emotional / situational response shaping

3. **Voice Renderer**
   - current: ElevenLabs or Piper
   - future: context-aware speech engine such as CSM-style generation

4. **Body**
   - Pi UI
   - kiosk display
   - local wake word
   - mic and speaker control
   - physical embodiment

## Near-Term Architecture

For now, Clive should continue using:

- OpenClaw for text generation and memory
- current host server for voice orchestration
- ElevenLabs / Piper for speech output

But the host should start preserving the kind of context a future CSM-like layer would want.

### Add A Rolling Spoken Context Buffer

The host should keep a short window of recent conversational turns, for example:

- speaker
- transcript
- timestamp
- mood / state if inferred
- optional audio path for the spoken response

This should live as a lightweight conversation context, separate from deep long-term memory.

### Add Response-Shaping Metadata

Before TTS, the host should shape each response with lightweight metadata such as:

- brevity target
- conversational energy
- seriousness / playfulness
- tenderness / firmness
- whether the moment calls for interruption-friendly phrasing

This is a bridge step between plain text generation and future contextual speech generation.

## Medium-Term Architecture

Once Clive has stable memory and conversational flow, add a more context-aware voice layer.

### Path A: Better TTS Prompting / Style Control

Use the existing TTS engine but add:

- style presets
- mood-conditioned phrasing
- shorter and more interruption-friendly sentence shaping
- pacing control that depends on context

This is the easiest stable path.

### Path B: CSM-Style Host Voice Engine

On a sufficiently capable host machine with GPU:

- keep OpenClaw generating text
- keep a rolling context of prior text/audio segments
- feed those segments into a context-aware speech generator
- generate speech that reflects recent conversation history

This is the path most aligned with Sesame's approach, but it is heavier and not Pi-suitable.

## Long-Term Clive Voice Stack

Ideal future architecture:

1. User speaks
2. STT produces transcript
3. OpenClaw generates response text based on soul, memory, and context
4. Host shapes the response for conversational intent
5. Voice engine renders speech using recent context
6. Pi plays the result and remains ready for interruption / follow-up

## Design Principles To Preserve

- Clive is a person first, not a feature bundle
- voice should reflect the moment, not just the sentence
- short turns should feel light and immediate
- long turns should feel invited, not automatic
- interruptions are part of the design, not an error case
- memory should shape judgment more than verbosity

## Practical Recommendation

Right now, do **not** try to replace the whole TTS stack with CSM.

Instead:

1. improve Clive's soul, identity, and memory
2. improve runtime conversational shaping
3. store rolling turn context
4. make interruption and barge-in feel natural
5. revisit a CSM-style voice engine later on a GPU-capable host

## Actionable Next Steps

1. Add a short rolling conversation-context object in the host
2. Add response-style metadata before TTS
3. Continue refining soul / memory / runtime prompt together
4. Keep Clive's responses brief and interruption-friendly
5. Treat context-aware speech generation as a host-side future upgrade, not a Pi feature
