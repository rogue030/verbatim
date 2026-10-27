// Summaries and action items from Claude. The API key stays on this device and
// requests go straight from the phone to Anthropic.

import {
  stamp, speakerName, dateLine, fmtDuration, typeLabel, spokenSegments,
} from './util.js';

const MODEL = 'claude-opus-5-5';

let sdkPromise;
const loadSDK = () => (sdkPromise ??= import('./vendor/anthropic-sdk.mjs').then((m) => m.default));

export class SummaryError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const SYSTEM = `You turn transcripts from live speech recognition into clear, accurate notes.

About the transcript:
- It was captured in real time by a phone's speech recognizer, so expect misheard words, missing punctuation and run-on sentences. Where the intended word is obvious from context, use it without comment. Where it isn't, keep the original wording rather than guessing.
- Speaker names were tagged by hand while recording and can lag the real speaker by a sentence or two. Treat them as a strong hint, not a fact.
- Lines starting with ★ were marked as important by the person recording. Give them weight.
- Text in square brackets, such as [Paused for 4 min], marks a gap where nothing was captured.

Only state what the transcript supports. Don't invent names, numbers, dates or decisions. Write the notes in the same language as the transcript. Reply with the notes in Markdown, in exactly the format requested, with no preamble or closing remarks.`;

const MEETING_FORMAT = `Write meeting notes in this format:

## Summary
Two to four sentences on what the meeting was about and where it landed.

## Key points
- The main things discussed, one line each.

## Decisions
- Each decision that was made. Write "None recorded." if there were none.

## Action items
- [ ] **Owner** — the task, with the due date if one was mentioned. Use **Unassigned** when nobody took it on.
Write "None recorded." if there were none.

## Open questions
- Questions raised but not resolved. Leave this section out if there were none.`;

const LECTURE_FORMAT = `Write study notes in this format:

## Summary
Three to five sentences covering the lecture's topic and main argument.

## Main ideas
- The core concepts in the order they were taught, one or two lines each.

## Key terms
- **Term** — the definition as the lecturer gave it.

## Examples
- Examples, cases or evidence used to illustrate the ideas. Leave this section out if there were none.

## Assignments and dates
- [ ] Readings, homework, deadlines or exam details that were announced. Write "None mentioned." if there were none.

## Review questions
1. Four or five questions that test understanding of this lecture.`;

export function transcriptForPrompt(session) {
  return session.segments
    .filter((s) => (s.kind === 'note' ? s.text : s.text.trim()))
    .map((s) => {
      if (s.kind === 'note') return `[${s.text}]`;
      const line = `[${stamp(session, s, 'elapsed')}] ${speakerName(session, s.speaker)}: ${s.text.trim()}`;
      return s.starred ? `★ ${line}` : line;
    })
    .join('\n');
}

export function buildPrompt(session) {
  const speakers = [...new Set(spokenSegments(session).map((s) => speakerName(session, s.speaker)))];
  const kind = typeLabel(session.type).toLowerCase();
  const user = `Here is the transcript of a ${kind} titled "${session.title}", recorded ${dateLine(session.startedAt)} (${fmtDuration(session.activeMs)}). Speakers: ${speakers.join(', ') || 'unknown'}.

<transcript>
${transcriptForPrompt(session)}
</transcript>

${session.type === 'lecture' ? LECTURE_FORMAT : MEETING_FORMAT}`;
  return { system: SYSTEM, user };
}

// The same request as one block of text, for pasting into the Claude app.
export function claudeAppPrompt(session) {
  const { system, user } = buildPrompt(session);
  return `${system}\n\n${user}`;
}

export async function summarize({ apiKey, session, onText, signal }) {
  const Anthropic = await loadSDK();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const { system, user } = buildPrompt(session);

  let text = '';
  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 64000,
      // If a safety classifier declines, the API retries on Anthropic's
      // recommended fallback model inside the same request.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system,
      messages: [{ role: 'user', content: user }],
    },
    { signal },
  );
  stream.on('streamEvent', (event) => {
    // A fallback starts the answer over; drop the partial text from the first attempt.
    if (event.type === 'content_block_start' && event.content_block?.type === 'fallback') {
      text = '';
      onText?.(text);
    }
  });
  stream.on('text', (delta) => {
    text += delta;
    onText?.(text);
  });

  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    throw toSummaryError(err, Anthropic);
  }

  if (message.stop_reason === 'refusal') {
    throw new SummaryError('refusal', 'Claude declined to summarize this transcript. You can still copy the prompt into the Claude app and edit it there.');
  }
  let start = 0;
  message.content.forEach((block, i) => {
    if (block.type === 'fallback') start = i + 1;
  });
  const finalText = message.content.slice(start)
    .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!finalText) throw new SummaryError('empty', 'Claude sent back an empty summary. Try again.');
  return { text: finalText, model: message.model, truncated: message.stop_reason === 'max_tokens' };
}

function toSummaryError(err, A) {
  if (err instanceof A.APIUserAbortError) return new SummaryError('aborted', 'Stopped.');
  if (err instanceof A.AuthenticationError) return new SummaryError('auth', 'Anthropic rejected the API key. Check it in Settings.');
  if (err instanceof A.PermissionDeniedError) return new SummaryError('auth', "This API key can't use Claude Opus 5.5. Check the key's workspace in the Anthropic Console.");
  if (err instanceof A.RateLimitError) return new SummaryError('rate', 'Too many requests right now. Wait a minute and try again.');
  if (err instanceof A.APIConnectionError) return new SummaryError('network', "Couldn't reach Claude. Check your internet connection and try again.");
  if (err instanceof A.APIError) {
    if (/credit balance/i.test(err.message)) return new SummaryError('billing', 'Your Anthropic account is out of credit. Add credit in the Anthropic Console, then try again.');
    if ((err.status ?? 0) >= 500) return new SummaryError('server', 'Claude is busy right now. Try again in a minute.');
    return new SummaryError('api', err.message || 'Claude returned an error.');
  }
  return new SummaryError('unknown', err?.message || 'Something went wrong.');
}
