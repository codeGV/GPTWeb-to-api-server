import { randomBytes } from 'crypto';
import { Response } from 'express';

/**
 * Helpers that turn OpenAI-style requests into a plain prompt for the browser
 * session, and turn the plain-text answer back into OpenAI-shaped responses.
 */

export const DEFAULT_MODEL = 'gptweb-to-api';

export const MODEL_IDS = [
  DEFAULT_MODEL,
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-5',
];

type ContentPart = { type?: string; text?: string; [key: string]: unknown };

export type InputMessage = {
  role: string;
  content?: string | ContentPart[] | null;
};

const newId = (prefix: string) => `${prefix}${randomBytes(12).toString('hex')}`;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Rough token estimate (~4 characters per token); the web UI does not report usage. */
export const estimateTokens = (text: string) =>
  text ? Math.max(1, Math.ceil(text.length / 4)) : 0;

export const contentToText = (content: InputMessage['content']): string => {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'image_url' || part.type === 'input_image') {
        return '[image omitted]';
      }
      if (part.type === 'input_file' || part.type === 'file') {
        return '[file omitted]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

const ROLE_LABELS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool result',
  function: 'Tool result',
};

/**
 * Builds the text typed into the chat UI. A single user message is sent as-is;
 * anything with instructions or history is flattened into a labelled transcript.
 */
export const messagesToPrompt = (messages: InputMessage[]): string => {
  const instructions: string[] = [];
  const turns: { role: string; text: string }[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const text = contentToText(msg.content).trim();
    if (!text) continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      instructions.push(text);
    } else {
      turns.push({ role: msg.role, text });
    }
  }

  if (!instructions.length && turns.length === 1 && turns[0].role === 'user') {
    return turns[0].text;
  }

  const sections = [
    'Treat this as a new conversation: ignore earlier messages in this chat. ' +
      'Reply as the assistant to the last user message below, with the reply text only.',
  ];
  if (instructions.length) {
    sections.push(`Instructions:\n${instructions.join('\n\n')}`);
  }
  if (turns.length) {
    sections.push(
      `Conversation:\n${turns
        .map((t) => `${ROLE_LABELS[t.role] || t.role}: ${t.text}`)
        .join('\n\n')}`,
    );
  }
  return sections.join('\n\n');
};

/** Converts Responses-API `instructions` + `input` into chat-style messages. */
export const responsesInputToMessages = (
  input: unknown,
  instructions?: unknown,
): InputMessage[] => {
  const messages: InputMessage[] = [];
  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item && typeof item === 'object') {
        if (item.type === 'function_call_output') {
          messages.push({
            role: 'tool',
            content:
              typeof item.output === 'string'
                ? item.output
                : JSON.stringify(item.output),
          });
        } else if (item.role) {
          messages.push({ role: item.role, content: item.content });
        }
      }
    }
  }
  return messages;
};

/**
 * Extracts the answer text from what the extension sent back. New extension
 * builds send `{ text }`; older builds send a model-written JSON envelope.
 */
export const answerToText = (answer: any): string => {
  if (answer == null) return '';
  if (typeof answer === 'string') return answer;
  if (typeof answer.text === 'string') return answer.text;

  const chatContent = answer.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string') return chatContent;

  if (Array.isArray(answer.output)) {
    const text = answer.output
      .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
      .filter((part: any) => typeof part?.text === 'string')
      .map((part: any) => part.text)
      .join('');
    if (text) return text;
  }
  return JSON.stringify(answer);
};

/** Splits text into word-sized pieces that join back to the exact original. */
export const chunkText = (text: string): string[] =>
  text.match(/[^\s]+\s*|\s+/g) || [];

export const openAiError = (
  res: Response,
  status: number,
  message: string,
  type = 'invalid_request_error',
  code: string | null = null,
) =>
  res.status(status).json({ error: { message, type, param: null, code } });

/** Starts an SSE response and sends keep-alive comments while the answer is pending. */
export const startSse = (res: Response) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  return () => clearInterval(keepAlive);
};

// ---------- Chat Completions ----------

export const buildChatCompletion = (
  text: string,
  model: string,
  prompt: string,
) => {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(text);
  return {
    id: newId('chatcmpl-'),
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text, refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    system_fingerprint: null,
  };
};

export const writeChatCompletionStream = (
  res: Response,
  text: string,
  model: string,
  prompt: string,
  includeUsage: boolean,
) => {
  const full = buildChatCompletion(text, model, prompt);
  const base = {
    id: full.id,
    object: 'chat.completion.chunk',
    created: full.created,
    model,
    system_fingerprint: null,
  };
  const send = (choices: unknown[], extra: object = {}) =>
    res.write(`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`);

  send([
    {
      index: 0,
      delta: { role: 'assistant', content: '' },
      logprobs: null,
      finish_reason: null,
    },
  ]);
  for (const piece of chunkText(text)) {
    send([
      { index: 0, delta: { content: piece }, logprobs: null, finish_reason: null },
    ]);
  }
  send([{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }]);
  if (includeUsage) {
    send([], { usage: full.usage });
  }
  res.write('data: [DONE]\n\n');
  res.end();
};

// ---------- Responses API ----------

export const createResponseShell = (body: any, model: string) => ({
  id: newId('resp_'),
  object: 'response',
  created_at: nowSeconds(),
  status: 'in_progress',
  error: null,
  incomplete_details: null,
  instructions: body?.instructions ?? null,
  max_output_tokens: body?.max_output_tokens ?? null,
  model,
  output: [] as any[],
  parallel_tool_calls: true,
  previous_response_id: body?.previous_response_id ?? null,
  reasoning: { effort: body?.reasoning?.effort ?? null, summary: null },
  store: false,
  temperature: body?.temperature ?? 1,
  text: { format: { type: 'text' } },
  tool_choice: 'auto',
  tools: [],
  top_p: body?.top_p ?? 1,
  truncation: 'disabled',
  usage: null as any,
  user: body?.user ?? null,
  metadata: body?.metadata ?? {},
});

export type ResponseShell = ReturnType<typeof createResponseShell>;

const outputMessage = (id: string, text: string) => ({
  id,
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});

export const completeResponse = (
  shell: ResponseShell,
  text: string,
  prompt: string,
) => {
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(text);
  return {
    ...shell,
    status: 'completed',
    output: [outputMessage(newId('msg_'), text)],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
  };
};

/** Writes Responses-API stream events; `start` is sent before the answer is ready. */
export const createResponseStream = (res: Response, shell: ResponseShell) => {
  let sequence = 0;
  const emit = (type: string, payload: object) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({
        type,
        sequence_number: sequence++,
        ...payload,
      })}\n\n`,
    );

  return {
    start() {
      emit('response.created', { response: shell });
      emit('response.in_progress', { response: shell });
    },
    finish(text: string, prompt: string) {
      const done = completeResponse(shell, text, prompt);
      const item = done.output[0];
      const ids = { item_id: item.id, output_index: 0, content_index: 0 };

      emit('response.output_item.added', {
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      });
      emit('response.content_part.added', {
        ...ids,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      for (const piece of chunkText(text)) {
        emit('response.output_text.delta', { ...ids, delta: piece, logprobs: [] });
      }
      emit('response.output_text.done', { ...ids, text, logprobs: [] });
      emit('response.content_part.done', { ...ids, part: item.content[0] });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response: done });
      res.end();
    },
    fail(message: string, code: string) {
      emit('response.failed', {
        response: { ...shell, status: 'failed', error: { code, message } },
      });
      res.end();
    },
  };
};
