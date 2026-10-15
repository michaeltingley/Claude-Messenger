import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/** RFC 6455's fixed key suffix, from which the handshake's answer is derived. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const TEXT = 0x1;
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;

/**
 * The server end of a WebSocket (RFC 6455), for a stand-in server: as much
 * of the protocol as Node's own client speaks to it. Text frames each way,
 * ping, and both ways to end it: a close frame, or the connection cut as a
 * crashed server or a lost network cuts it. Every frame a client sends is
 * whole, as Node's are; a fragmented one ends the connection.
 */
export class WebSocketPeer {
  private received = Buffer.alloc(0);
  private ended = false;

  private constructor(
    private readonly socket: Duplex,
    private readonly onText: (text: string) => void,
  ) {
    socket.on('data', (chunk: Buffer) => this.read(chunk));
    socket.on('close', () => (this.ended = true));
    // A client gone mid-write: nothing to do but let the connection go.
    socket.on('error', () => socket.destroy());
  }

  /** Completes the opening handshake `request` asked for, on its socket. */
  static accept(request: IncomingMessage, socket: Duplex, onText: (text: string) => void): WebSocketPeer {
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}${GUID}`).digest('base64');
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join(
        '\r\n',
      ),
    );
    return new WebSocketPeer(socket, onText);
  }

  /** Whether the connection is gone, however it ended. */
  get closed(): boolean {
    return this.ended;
  }

  send(text: string): void {
    this.frame(TEXT, Buffer.from(text, 'utf8'));
  }

  /** Ends it as a server going away does: a close frame, then the connection. */
  close(code = 1001): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.frame(CLOSE, payload);
    this.socket.end();
  }

  /** Cuts the connection with no close frame, as a crash or a lost network does. */
  cut(): void {
    this.socket.destroy();
  }

  private frame(opcode: number, payload: Buffer): void {
    if (this.ended || this.socket.writableEnded) return;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 0x10000) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Reads every whole frame received so far; a partial one waits for the rest. */
  private read(chunk: Buffer): void {
    this.received = Buffer.concat([this.received, chunk]);
    for (;;) {
      const frame = this.nextFrame();
      if (frame === undefined) return;
      if (!frame.fin) return this.cut();
      if (frame.opcode === TEXT) this.onText(frame.payload.toString('utf8'));
      else if (frame.opcode === PING) this.frame(PONG, frame.payload);
      else if (frame.opcode === CLOSE) {
        // The client's close, answered as the protocol asks: the same code back.
        this.frame(CLOSE, frame.payload.subarray(0, 2));
        this.socket.end();
        return;
      }
    }
  }

  private nextFrame(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
    const data = this.received;
    if (data.length < 2) return undefined;
    let length = data[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (data.length < 4) return undefined;
      length = data.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (data.length < 10) return undefined;
      length = Number(data.readBigUInt64BE(2));
      offset = 10;
    }
    const masked = (data[1]! & 0x80) !== 0;
    const mask = masked ? data.subarray(offset, offset + 4) : undefined;
    if (masked) offset += 4;
    if (data.length < offset + length) return undefined;
    const payload = Buffer.from(data.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
    this.received = data.subarray(offset + length);
    return { fin: (data[0]! & 0x80) !== 0, opcode: data[0]! & 0x0f, payload };
  }
}
