import { yuv420ToRgbaInto } from '@/lib/video';

type RenderMsg = {
  type: 'render';
  width: number;
  height: number;
  data: ArrayBuffer;
  frameId: number;
};

type ReleaseMsg = {
  type: 'release';
};

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

// rgba sẽ trỏ trực tiếp vào img.data
let img: ImageData | null = null;
let rgba: Uint8ClampedArray | null = null;

function ensure(w: number, h: number) {
  w = w & ~1;
  h = h & ~1;

  if (!canvas) canvas = new OffscreenCanvas(w, h);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  if (!ctx) ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('OffscreenCanvas 2d context not available');

  // Tạo ImageData bằng overload (w, h) để tránh lỗi typing ArrayBufferLike/SharedArrayBuffer
  if (!img || img.width !== w || img.height !== h) {
    img = new ImageData(w, h);
    rgba = img.data; // Uint8ClampedArray chuẩn của ImageData
  } else if (!rgba) {
    rgba = img.data;
  }
}

self.onmessage = async (ev: MessageEvent<RenderMsg | ReleaseMsg>) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'release') {
    canvas = null;
    ctx = null;
    img = null;
    rgba = null;
    return;
  }

  if (msg.type !== 'render') return;

  const { width, height, data, frameId } = msg;
  if (!data || !width || !height) return;

  try {
    ensure(width, height);

    const yuv = new Uint8Array(data);
    yuv420ToRgbaInto(yuv, width, height, rgba!);

    ctx!.putImageData(img!, 0, 0);

    const bitmap = canvas!.transferToImageBitmap();
    (self as any).postMessage({ type: 'bitmap', width, height, bitmap, frameId }, [bitmap]);
  } catch (e) {
    console.error('[yuvRender.worker] render error', e);
    (self as any).postMessage({ type: 'error', message: String(e), frameId });
  }
};
