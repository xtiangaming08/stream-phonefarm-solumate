import { concatU8 } from './bytes';
import { COMMON_PARAMS, type StreamConfig } from './config';

// Build config -> BINARY (Uint8Array 36 bytes)
export function buildConfigBinary(cfg: StreamConfig): Uint8Array {
  const out = new Uint8Array(36);

  out[0] = 0x65; // magic/opcode

  const brScaled = Math.floor((cfg.bitrate ?? 0) / 256) >>> 0;
  out[1] = brScaled & 0xff;
  out[2] = (brScaled >>> 8) & 0xff;
  out[3] = (brScaled >>> 16) & 0xff;
  out[4] = (brScaled >>> 24) & 0xff;

  out[8] = (cfg.maxFps ?? 0) & 0xff;
  out[9] = (cfg.iFrameInterval ?? 0) & 0xff;

  const w = (cfg.bounds?.width ?? 0) & 0xffff;
  const h = (cfg.bounds?.height ?? 0) & 0xffff;
  out[10] = (w >>> 8) & 0xff;
  out[11] = w & 0xff;
  out[12] = (h >>> 8) & 0xff;
  out[13] = h & 0xff;

  out[22] = cfg.sendFrameMeta ? 1 : 0;
  out[23] = (cfg.lockedVideoOrientation ?? 0) & 0xff;

  const did = (cfg.displayId ?? 0) >>> 0;
  out[24] = did & 0xff;
  out[25] = (did >>> 8) & 0xff;
  out[26] = (did >>> 16) & 0xff;
  out[27] = (did >>> 24) & 0xff;

  return out;
}

// Decode the 36-byte binary format back into a StreamConfig (inverse of buildConfigBinary)
export function parseConfigBinary(buf: Uint8Array | ArrayBuffer): StreamConfig {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 28) throw new Error('Invalid config payload (too short)');
  if (u8[0] !== 0x65) throw new Error('Invalid config payload (bad magic)');

  const brScaled = (u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24)) >>> 0;
  const bitrate = brScaled * 256;

  const maxFps = u8[8];
  const iFrameInterval = u8[9];

  const width = ((u8[10] << 8) | u8[11]) & 0xffff;
  const height = ((u8[12] << 8) | u8[13]) & 0xffff;

  const sendFrameMeta = !!u8[22];

  // lockedVideoOrientation is stored as u8; 0xff represents -1 (no lock)
  const lockedRaw = u8[23];
  const lockedVideoOrientation = lockedRaw === 0xff ? -1 : lockedRaw;

  const displayId = (u8[24] | (u8[25] << 8) | (u8[26] << 16) | (u8[27] << 24)) >>> 0;

  return {
    bitrate,
    maxFps,
    iFrameInterval,
    bounds: { width, height },
    sendFrameMeta,
    lockedVideoOrientation,
    displayId,
  };
}

export type MakeWsUrlArgs = {
  wsServer: string;
  deviceParam: string | null;
  udid: string;
  restart?: boolean;
};

export function makeWsUrl({ wsServer, deviceParam, udid, restart = false }: MakeWsUrlArgs): string {
  if (!deviceParam) throw new Error('Missing required query param: device');

  const u = new URL(wsServer);
  u.searchParams.set('action', COMMON_PARAMS.action);
  u.searchParams.set('remote', COMMON_PARAMS.remote);

  u.searchParams.set('udid', udid);
  u.searchParams.set('device', deviceParam);

  const upstreamPath = restart ? '/?restart=1' : '/';
  u.searchParams.set('path', upstreamPath);

  return u.toString();
}

export function stripStartCode(nalu: Uint8Array): Uint8Array {
  if (nalu.length >= 4 && nalu[0] === 0x00 && nalu[1] === 0x00) {
    if (nalu[2] === 0x01) return nalu.slice(3);
    if (nalu[2] === 0x00 && nalu[3] === 0x01) return nalu.slice(4);
  }
  return nalu;
}

export class AnnexBSplitter {
  private onNalu: (naluWithStartCode: Uint8Array) => void;
  private buf: Uint8Array;
  private seen: boolean;

  constructor(onNalu: (naluWithStartCode: Uint8Array) => void) {
    this.onNalu = onNalu;
    this.buf = new Uint8Array(0);
    this.seen = false;
  }

  private findStart(u8: Uint8Array, from: number): { idx: number; len: number } | null {
    for (let i = from; i + 3 < u8.length; i++) {
      if (u8[i] === 0x00 && u8[i + 1] === 0x00) {
        if (u8[i + 2] === 0x01) return { idx: i, len: 3 };
        if (u8[i + 2] === 0x00 && u8[i + 3] === 0x01) return { idx: i, len: 4 };
      }
    }
    return null;
  }

  push(chunk: Uint8Array): void {
    this.buf = concatU8(this.buf, chunk);

    if (!this.seen) {
      const first = this.findStart(this.buf, 0);
      if (!first) {
        if (this.buf.length > 4096) this.buf = this.buf.slice(this.buf.length - 4096);
        return;
      }
      this.seen = true;
      if (first.idx > 0) this.buf = this.buf.slice(first.idx);
    }

    let pos = 0;
    while (true) {
      const s1 = this.findStart(this.buf, pos);
      if (!s1) break;
      const s2 = this.findStart(this.buf, s1.idx + s1.len);
      if (!s2) {
        if (s1.idx > 0) this.buf = this.buf.slice(s1.idx);
        return;
      }
      const nalu = this.buf.slice(s1.idx, s2.idx);
      pos = s2.idx;
      if (nalu.length > s1.len) this.onNalu(nalu);
    }
  }
}

export function yuv420ToRgba(yuv: Uint8Array, w: number, h: number): Uint8ClampedArray {
  // Make sure width/height are even
  w = w & ~1;
  h = h & ~1;

  const frameSize = w * h;
  const q = frameSize >> 2;
  const need = frameSize + q + q;

  if (yuv.length < need) return new Uint8ClampedArray(w * h * 4);

  const Y = yuv.subarray(0, frameSize);
  const U = yuv.subarray(frameSize, frameSize + q);
  const V = yuv.subarray(frameSize + q, frameSize + 2 * q);

  const rgba = new Uint8ClampedArray(w * h * 4);
  let yp = 0;

  for (let j = 0; j < h; j++) {
    const uvRow = (j >> 1) * (w >> 1);
    for (let i = 0; i < w; i++, yp++) {
      const uv = uvRow + (i >> 1);
      const y = Y[yp];
      const u = U[uv] - 128;
      const v = V[uv] - 128;

      let r = y + 1.402 * v;
      let g = y - 0.344136 * u - 0.714136 * v;
      let b = y + 1.772 * u;

      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;

      const p = yp * 4;
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = 255;
    }
  }

  return rgba;
}

// Faster variant: write into a preallocated RGBA buffer (length must be >= w*h*4)
// Uses integer math and clamps to 0..255. Suitable for worker-side conversion.
export function yuv420ToRgbaInto(yuv: Uint8Array, w: number, h: number, outRgba: Uint8ClampedArray): void {
  w = w & ~1;
  h = h & ~1;

  const frameSize = w * h;
  const q = frameSize >> 2;
  const need = frameSize + q + q;
  if (yuv.length < need) {
    // Fill black
    outRgba.fill(0);
    for (let i = 3; i < outRgba.length; i += 4) outRgba[i] = 255;
    return;
  }

  const Y = yuv.subarray(0, frameSize);
  const U = yuv.subarray(frameSize, frameSize + q);
  const V = yuv.subarray(frameSize + q, frameSize + 2 * q);

  let yp = 0;
  let p = 0;

  for (let j = 0; j < h; j++) {
    const uvRow = (j >> 1) * (w >> 1);
    for (let i = 0; i < w; i++, yp++) {
      const uv = uvRow + (i >> 1);
      const y = Y[yp] | 0;
      const u = (U[uv] | 0) - 128;
      const v = (V[uv] | 0) - 128;

      // Integer approximation (BT.601)
      // r = y + 1.402*v
      // g = y - 0.344*u - 0.714*v
      // b = y + 1.772*u
      let r = y + ((359 * v) >> 8);
      let g = y - ((88 * u + 183 * v) >> 8);
      let b = y + ((454 * u) >> 8);

      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;

      outRgba[p++] = r;
      outRgba[p++] = g;
      outRgba[p++] = b;
      outRgba[p++] = 255;
    }
  }
}
