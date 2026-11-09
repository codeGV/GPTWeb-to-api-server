import {
  Body,
  Controller,
  Get,
  GatewayTimeoutException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { SocketGateway } from '../socket/socket.gateway';
import {
  DEFAULT_MODEL,
  MODEL_IDS,
  InputMessage,
  answerToText,
  buildChatCompletion,
  completeResponse,
  createResponseShell,
  createResponseStream,
  messagesToPrompt,
  openAiError,
  responsesInputToMessages,
  startSse,
  writeChatCompletionStream,
} from './openai.format';

const isStreaming = (body: any) => body?.stream === true || body?.stream === 'true';

const errorDetails = (error: unknown) =>
  error instanceof GatewayTimeoutException
    ? {
        status: 504,
        type: 'api_error',
        code: 'timeout',
        message:
          'Timed out waiting for the browser extension. Make sure the GPT Web to API extension is connected and its chat tab is open.',
      }
    : {
        status: 500,
        type: 'api_error',
        code: 'internal_error',
        message: error instanceof Error ? error.message : 'Unexpected error',
      };

/**
 * OpenAI-compatible endpoints. Requests are flattened into a plain prompt, the
 * browser extension answers in plain text, and the response envelope is built
 * here so it always matches the OpenAI schema.
 *
 * Routes are served with and without the `/v1` prefix, so both
 * `base_url=".../app/<room>"` and `base_url=".../app/<room>/v1"` work.
 * Registered before AppController so these take precedence over its wildcards.
 */
@Controller('app')
export class OpenAiController {
  constructor(private readonly gateway: SocketGateway) {}

  private async ask(roomId: string, route: string, body: any, prompt: string) {
    const answer = await this.gateway.sendToRoomAndWait(roomId, {
      route,
      body,
      prompt,
      responseMode: 'text',
    });
    return answerToText(answer);
  }

  @Get([':roomId/v1/models', ':roomId/models'])
  listModels() {
    return {
      object: 'list',
      data: MODEL_IDS.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'gptweb-to-api',
      })),
    };
  }

  @Get([':roomId/v1/models/:model', ':roomId/models/:model'])
  getModel(@Param('model') model: string) {
    // The browser session decides the real model, so any id is accepted.
    return { id: model, object: 'model', created: 0, owned_by: 'gptweb-to-api' };
  }

  @Post([':roomId/v1/chat/completions', ':roomId/chat/completions'])
  async chatCompletions(
    @Param('roomId') roomId: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const messages: InputMessage[] = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return openAiError(res, 400, "'messages' must be a non-empty array.");
    }
    const prompt = messagesToPrompt(messages);
    if (!prompt) {
      return openAiError(res, 400, "'messages' contain no text content.");
    }
    const model = body.model || DEFAULT_MODEL;

    if (!isStreaming(body)) {
      try {
        const text = await this.ask(roomId, 'v1/chat/completions', body, prompt);
        return res.status(200).json(buildChatCompletion(text, model, prompt));
      } catch (error) {
        const e = errorDetails(error);
        return openAiError(res, e.status, e.message, e.type, e.code);
      }
    }

    const stopKeepAlive = startSse(res);
    try {
      const text = await this.ask(roomId, 'v1/chat/completions', body, prompt);
      stopKeepAlive();
      writeChatCompletionStream(
        res,
        text,
        model,
        prompt,
        body.stream_options?.include_usage === true,
      );
    } catch (error) {
      stopKeepAlive();
      const e = errorDetails(error);
      res.write(
        `data: ${JSON.stringify({
          error: { message: e.message, type: e.type, param: null, code: e.code },
        })}\n\n`,
      );
      res.end();
    }
  }

  @Post([':roomId/v1/responses', ':roomId/responses'])
  async responses(
    @Param('roomId') roomId: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    if (body?.input == null) {
      return openAiError(res, 400, "'input' is required.");
    }
    const prompt = messagesToPrompt(
      responsesInputToMessages(body.input, body.instructions),
    );
    if (!prompt) {
      return openAiError(res, 400, "'input' contains no text content.");
    }
    const shell = createResponseShell(body, body.model || DEFAULT_MODEL);

    if (!isStreaming(body)) {
      try {
        const text = await this.ask(roomId, 'v1/responses', body, prompt);
        return res.status(200).json(completeResponse(shell, text, prompt));
      } catch (error) {
        const e = errorDetails(error);
        return openAiError(res, e.status, e.message, e.type, e.code);
      }
    }

    const stopKeepAlive = startSse(res);
    const stream = createResponseStream(res, shell);
    stream.start();
    try {
      const text = await this.ask(roomId, 'v1/responses', body, prompt);
      stopKeepAlive();
      stream.finish(text, prompt);
    } catch (error) {
      stopKeepAlive();
      const e = errorDetails(error);
      stream.fail(e.message, e.code);
    }
  }
}
