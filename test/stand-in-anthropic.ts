import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

/**
 * A stand-in for Anthropic's Messages API, for running the real Claude Code
 * with no account: it records every request and answers each one for a
 * message with `reply`, streamed or not, as it was asked.
 */
export class StandInAnthropic {
  requests: RecordedRequest[] = [];
  reply = '**Needs you**\n- Nothing is waiting on you.';
  private server?: Server;

  /** Every request for a message, oldest first, its body parsed. */
  messageRequests(): Array<Record<string, unknown>> {
    return this.requests
      .filter((r) => r.method === 'POST' && r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens'))
      .map((r) => JSON.parse(r.body) as Record<string, unknown>);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const url = req.url ?? '';
        this.requests.push({ method: req.method ?? '', url, body });
        if (req.method === 'POST' && url.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }));
        } else if (req.method === 'POST' && url.startsWith('/v1/messages')) {
          this.answer(JSON.parse(body) as { model?: string; stream?: boolean }, res);
        } else {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not modelled' } }));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private answer(request: { model?: string; stream?: boolean }, res: import('node:http').ServerResponse): void {
    const message = {
      id: 'msg_stand_in',
      type: 'message',
      role: 'assistant',
      model: request.model ?? 'claude-sonnet',
      content: [] as unknown[],
      stop_reason: null as string | null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    if (!request.stream) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...message, content: [{ type: 'text', text: this.reply }], stop_reason: 'end_turn' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: this.reply } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  }
}
