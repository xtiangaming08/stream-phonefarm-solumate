// Client-side implementation of the server's WebSocket multiplexer.
//
// Protocol framing (outer):
//   [type: u8][channelId: u32LE][payload...]
//
// Nested channels are created by sending a CreateChannel message as *Data* to the parent channel.
// This matches `server/src/packages/multiplexer/*`.

export enum MuxMessageType {
  CreateChannel = 4,
  CloseChannel = 8,
  RawBinaryData = 16,
  RawStringData = 32,
  Data = 64,
}

const te = new TextEncoder();
const td = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}

export function ascii4(s: string): Uint8Array {
  if (s.length !== 4) throw new Error('ascii4 requires length=4');
  return te.encode(s);
}

export function utf8(s: string): Uint8Array {
  return te.encode(s);
}

export function int32le(n: number): Uint8Array {
  return u32le(n | 0);
}

export function int32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

export function int16be(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n | 0, false);
  return b;
}

export function int8(n: number): Uint8Array {
  return new Uint8Array([n & 0xff]);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  return concat(parts);
}

type ChannelEntry = { channel: MuxChannel; emitter: EventTarget };

export class MuxChannel extends EventTarget {
  public readonly CONNECTING = 0;
  public readonly OPEN = 1;
  public readonly CLOSING = 2;
  public readonly CLOSED = 3;

  public readyState = this.CONNECTING;
  public binaryType: BinaryType = 'arraybuffer';

  private channels = new Map<number, ChannelEntry>();
  // Queue while connecting. Keep only types that WebSocket#send accepts in browsers.
  private storage: (string | Uint8Array)[] = [];
  private nextId = 0;

  private onopen: ((this: WebSocket, ev: Event) => any) | null = null;
  private onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null;
  private onerror: ((this: WebSocket, ev: Event) => any) | null = null;
  private onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null;

  constructor(
    // Root: ws is WebSocket, emitter is ws.
    // Child: ws is parent MuxChannel, emitter is an internal EventTarget.
    public readonly ws: WebSocket | MuxChannel,
    public readonly id: number,
    private readonly messageEmitter: EventTarget,
  ) {
    super();

    if (this.id === 0 && this.ws instanceof WebSocket) {
      this.ws.binaryType = 'arraybuffer';
      this.readyState = this.ws.readyState;

      this.ws.addEventListener('open', (e) => {
        this.readyState = this.ws.readyState;
        this.dispatchEvent(e);
      });
      this.ws.addEventListener('close', (e) => {
        this.readyState = this.ws.readyState;
        this.dispatchEvent(e);
        this.channels.clear();
      });
      this.ws.addEventListener('error', (e) => {
        this.readyState = this.ws.readyState;
        this.dispatchEvent(e);
        this.channels.clear();
      });
    }

    const onMessage = (event: Event) => {
      const ev = event as MessageEvent;
      const data = ev.data;
      if (!(data instanceof ArrayBuffer)) return;
      const msg = MuxMessage.parse(data);

      switch (msg.type) {
        case MuxMessageType.CreateChannel: {
          const { channelId, payload } = msg;
          // Make sure ids don't collide (server may create channel ids).
          if (this.nextId < channelId) this.nextId = channelId;
          const channel = this._createChannel(channelId, false);
          this.dispatchEvent(new CustomEvent('channel', { detail: { channel, data: payload } }));
          break;
        }
        case MuxMessageType.RawStringData: {
          const entry = this.channels.get(msg.channelId);
          if (!entry) return;
          const text = td.decode(new Uint8Array(msg.payload));
          entry.channel.dispatchEvent(new MessageEvent('message', { data: text }));
          break;
        }
        case MuxMessageType.RawBinaryData: {
          const entry = this.channels.get(msg.channelId);
          if (!entry) return;
          entry.channel.dispatchEvent(new MessageEvent('message', { data: msg.payload }));
          break;
        }
        case MuxMessageType.Data: {
          // Data is dispatched to the *emitter* of the targeted channel.
          const entry = this.channels.get(msg.channelId);
          if (!entry) return;
          (entry.emitter as any).dispatchEvent(new MessageEvent('message', { data: msg.payload }));
          break;
        }
        case MuxMessageType.CloseChannel: {
          const entry = this.channels.get(msg.channelId);
          if (!entry) return;
          const { code, reason } = MuxMessage.parseClosePayload(msg.payload);
          entry.channel.readyState = entry.channel.CLOSING;
          try {
            entry.channel.dispatchEvent(
              new CloseEvent('close', { code, reason, wasClean: code === 1000 }),
            );
          } finally {
            entry.channel.readyState = entry.channel.CLOSED;
            this.channels.delete(msg.channelId);
          }
          break;
        }
        default:
          this.dispatchEvent(new Event('error'));
      }
    };

    this.messageEmitter.addEventListener('message', onMessage as any);

    // Flush pending data when this channel opens.
    this.addEventListener('open', () => {
      if (!this.storage.length) return;
      const items = [...this.storage];
      this.storage.length = 0;
      for (const d of items) {
        this._send(d);
      }
    });
  }

  static wrap(ws: WebSocket): MuxChannel {
    return new MuxChannel(ws, 0, ws);
  }

  private _createChannel(id: number, sendOpenEvent: boolean): MuxChannel {
    const emitter = new EventTarget();
    // Child channel listens for *nested* multiplexer messages via emitter.
    const channel = new MuxChannel(this, id, emitter);
    this.channels.set(id, { channel, emitter });

    if (sendOpenEvent) {
      if (this.readyState === this.OPEN) {
        queueMicrotask(() => {
          channel.readyState = channel.OPEN;
          channel.dispatchEvent(new Event('open'));
        });
      }
    } else {
      channel.readyState = this.readyState;
    }

    channel.addEventListener('close', () => {
      this.channels.delete(id);
    });

    return channel;
  }

  private getNextId(): number {
    let hitTop = false;
    while (this.channels.has(++this.nextId)) {
      if (this.nextId >= 0xffffffff) {
        if (hitTop) throw new Error('No available channel id');
        this.nextId = 0;
        hitTop = true;
      }
    }
    return this.nextId;
  }

  public createChannel(initData: Uint8Array): MuxChannel {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) {
      throw new Error('Incorrect socket state');
    }
    const id = this.getNextId();
    const channel = this._createChannel(id, true);
    this.sendData(MuxMessage.createBuffer(MuxMessageType.CreateChannel, id, initData));
    return channel;
  }

  public send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.ws instanceof MuxChannel) {
      // Channel -> wrap into Raw* frame and send as Data to parent.
      if (typeof data === 'string') {
        this.ws.sendData(MuxMessage.createBuffer(MuxMessageType.RawStringData, this.id, te.encode(data)));
      } else {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        this.ws.sendData(MuxMessage.createBuffer(MuxMessageType.RawBinaryData, this.id, u8));
      }
      return;
    }

    // Root raw send.
    if (typeof data === 'string') {
      this._send(data);
    } else {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      this._send(u8);
    }
  }

  /** Send binary payload as `MessageType.Data` (used for nested control messages). */
  public sendData(data: ArrayBuffer | Uint8Array): void {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (this.ws instanceof MuxChannel) {
      // Wrap into outer Data frame targeted at THIS channel id, and send to parent.
      const frame = MuxMessage.createBuffer(MuxMessageType.Data, this.id, u8);
      this.ws.sendData(frame);
      return;
    }
    this._send(u8);
  }

  private _send(data: string | Uint8Array): void {
    if (this.readyState === this.OPEN) {
      if (this.ws instanceof WebSocket) {
        this.ws.send(data);
      } else {
        // should not happen
        (this.ws as any).sendData(data);
      }
      return;
    }
    // Queue while connecting.
    if (this.ws instanceof WebSocket && this.readyState === this.ws.CONNECTING) {
      // `Uint8Array#buffer` may be a SharedArrayBuffer in some runtimes;
      // also WebSocket#send doesn't accept SharedArrayBuffer. Always copy.
      this.storage.push(typeof data === 'string' ? data : data.slice());
      return;
    }
    throw new Error('Socket is already in CLOSING or CLOSED state');
  }

  public close(code = 1000, reason?: string): void {
    if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
    if (this.id !== 0) {
      this.readyState = this.CLOSING;
      try {
        const payload = MuxMessage.buildClosePayload(code, reason);
        const frame = MuxMessage.createBuffer(MuxMessageType.CloseChannel, this.id, payload);
        // Send close message as Data to parent (same as server).
        (this.ws as MuxChannel).sendData(frame);
        this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
      } finally {
        this.readyState = this.CLOSED;
      }
    } else {
      (this.ws as WebSocket).close(code, reason);
    }
  }

  // WS-like handler props (optional)
  set onopenHandler(fn: ((this: WebSocket, ev: Event) => any) | null) {
    this.onopen = fn;
  }
  set oncloseHandler(fn: ((this: WebSocket, ev: CloseEvent) => any) | null) {
    this.onclose = fn;
  }
  set onerrorHandler(fn: ((this: WebSocket, ev: Event) => any) | null) {
    this.onerror = fn;
  }
  set onmessageHandler(fn: ((this: WebSocket, ev: MessageEvent) => any) | null) {
    this.onmessage = fn;
  }

  // Forward events to handler props
  dispatchEvent(event: Event): boolean {
    if (event.type === 'open' && typeof this.onopen === 'function') (this.onopen as any).call(this, event);
    if (event.type === 'close' && typeof this.onclose === 'function') (this.onclose as any).call(this, event);
    if (event.type === 'error' && typeof this.onerror === 'function') (this.onerror as any).call(this, event);
    if (event.type === 'message' && typeof this.onmessage === 'function') (this.onmessage as any).call(this, event);
    return super.dispatchEvent(event);
  }
}

class MuxMessage {
  constructor(
    public readonly type: MuxMessageType,
    public readonly channelId: number,
    public readonly payload: ArrayBuffer,
  ) {}

  static parse(buffer: ArrayBuffer): MuxMessage {
    const u8 = new Uint8Array(buffer);
    if (u8.byteLength < 5) throw new Error('Invalid mux message');
    const type = u8[0] as MuxMessageType;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const channelId = dv.getUint32(1, true);
    const payload = buffer.slice(u8.byteOffset + 5, u8.byteOffset + u8.byteLength);
    return new MuxMessage(type, channelId, payload);
  }

  static createBuffer(type: MuxMessageType, channelId: number, payload?: Uint8Array): Uint8Array {
    const header = new Uint8Array(1 + 4);
    header[0] = type;
    header.set(u32le(channelId), 1);
    if (!payload || payload.byteLength === 0) return header;
    return concat([header, payload]);
  }

  static buildClosePayload(code: number, reason?: string): Uint8Array {
    const reasonBytes = reason ? te.encode(reason) : new Uint8Array();
    if (!reasonBytes.byteLength) return u16le(code);
    return concat([u16le(code), u32le(reasonBytes.byteLength), reasonBytes]);
  }

  static parseClosePayload(payload: ArrayBuffer): { code: number; reason: string } {
    let code = 1000;
    let reason = '';
    try {
      const dv = new DataView(payload);
      if (payload.byteLength >= 2) code = dv.getUint16(0, true);
      if (payload.byteLength > 6) {
        const len = dv.getUint32(2, true);
        const bytes = new Uint8Array(payload, 6, Math.min(len, payload.byteLength - 6));
        reason = td.decode(bytes);
      }
    } catch {
      // ignore
    }
    return { code, reason };
  }
}
