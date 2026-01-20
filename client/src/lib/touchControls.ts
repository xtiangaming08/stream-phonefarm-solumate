import { clamp, encodeScrollMessage, encodeTouchMessage, MotionAction } from './control';
import type { InputTarget } from '@/context/ActiveContext';

type TargetsGetter = () => InputTarget[];

type ActivePointerState = {
  pid: number;
  // Normalized (0..1) coords from the source canvas, later mapped to each target device.
  lastXY: { x01: number; y01: number };
  lastButtons: number;
  dirty: boolean;
};

function makePointerIdAllocator() {
  const idToPointer = new Map<number, number>();
  const pointerToId = new Map<number, number>();
  function alloc(browserPointerId: number): number {
    if (idToPointer.has(browserPointerId)) return idToPointer.get(browserPointerId)!;
    let pid = 0;
    while (pointerToId.has(pid)) pid++;
    idToPointer.set(browserPointerId, pid);
    pointerToId.set(pid, browserPointerId);
    return pid;
  }
  function free(browserPointerId: number) {
    const pid = idToPointer.get(browserPointerId);
    if (pid == null) return;
    idToPointer.delete(browserPointerId);
    pointerToId.delete(pid);
  }
  return { alloc, free };
}

function mapClientToNormXY(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const cw = rect.width || canvas.clientWidth || 1;
  const ch = rect.height || canvas.clientHeight || 1;

  const x01 = (clientX - rect.left) / cw;
  const y01 = (clientY - rect.top) / ch;

  return { x01, y01 };
}

function mapNormToDeviceXY(targetCanvas: HTMLCanvasElement, x01: number, y01: number) {
  const w = targetCanvas.width || 1;
  const h = targetCanvas.height || 1;
  const x = clamp(Math.round(x01 * w), 0, w);
  const y = clamp(Math.round(y01 * h), 0, h);
  return { x, y, w, h };
}

export function attachTouchControls(
  canvas: HTMLCanvasElement,
  getTargets: TargetsGetter,
  onActivate?: () => void,
): () => void {
  const ptr = makePointerIdAllocator();
  const active = new Map<number, ActivePointerState>();
  let raf = 0;

  function canSend() {
    const targets = getTargets();
    return targets.some((t) => t.ws && t.ws.readyState === WebSocket.OPEN);
  }

  function sendToTargets(makeMsg: (t: InputTarget) => Uint8Array) {
    const targets = getTargets();
    for (const t of targets) {
      if (!t.ws || t.ws.readyState !== WebSocket.OPEN) continue;
      try {
        t.ws.send(makeMsg(t));
      } catch {
        // ignore
      }
    }
  }

  function scheduleMoveFlush() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!canSend()) return;
      for (const st of active.values()) {
        if (!st.dirty) continue;
        st.dirty = false;
        const { x01, y01 } = st.lastXY;
        sendToTargets((t) => {
          const { x, y, w, h } = mapNormToDeviceXY(t.canvas, x01, y01);
          return encodeTouchMessage(MotionAction.MOVE, st.pid, x, y, w, h, 1, st.lastButtons);
        });
      }
    });
  }

  function onPointerDown(e: PointerEvent) {
    if (!canSend()) return;
    e.preventDefault();
    onActivate?.();

    canvas.focus?.();
    canvas.setPointerCapture?.(e.pointerId);

    const pid = ptr.alloc(e.pointerId);
    const { x01, y01 } = mapClientToNormXY(canvas, e.clientX, e.clientY);
    const buttons = e.buttons ?? 0;

    active.set(e.pointerId, {
      pid,
      lastXY: { x01, y01 },
      lastButtons: buttons,
      dirty: false,
    });

    sendToTargets((t) => {
      const { x, y, w, h } = mapNormToDeviceXY(t.canvas, x01, y01);
      return encodeTouchMessage(MotionAction.DOWN, pid, x, y, w, h, 1, buttons);
    });
  }

  function onPointerMove(e: PointerEvent) {
    if (!active.has(e.pointerId)) {
      if (((e.buttons ?? 0) | 0) !== 0 && canSend()) onPointerDown(e);
      return;
    }
    e.preventDefault();

    const st = active.get(e.pointerId)!;
    const { x01, y01 } = mapClientToNormXY(canvas, e.clientX, e.clientY);
    st.lastXY = { x01, y01 };
    st.lastButtons = e.buttons ?? st.lastButtons;
    st.dirty = true;

    scheduleMoveFlush();
  }

  function onPointerUpOrCancel(e: PointerEvent) {
    const st = active.get(e.pointerId);
    if (!st) return;
    e.preventDefault();


    const { x01, y01 } = mapClientToNormXY(canvas, e.clientX, e.clientY);

    if (st.dirty && canSend()) {
      st.dirty = false;
      sendToTargets((t) => {
        const { x, y, w, h } = mapNormToDeviceXY(t.canvas, x01, y01);
        return encodeTouchMessage(MotionAction.MOVE, st.pid, x, y, w, h, 1, st.lastButtons);
      });
    }

    sendToTargets((t) => {
      const { x, y, w, h } = mapNormToDeviceXY(t.canvas, x01, y01);
      return encodeTouchMessage(MotionAction.UP, st.pid, x, y, w, h, 0, 0);
    });

    active.delete(e.pointerId);
    ptr.free(e.pointerId);
  }

  function onWheel(e: WheelEvent) {
    if (!canSend()) return;
    e.preventDefault();
    onActivate?.();

    const { x01, y01 } = mapClientToNormXY(canvas, e.clientX, e.clientY);
    const hScroll = e.deltaX > 0 ? -1 : e.deltaX < 0 ? 1 : 0;
    const vScroll = e.deltaY > 0 ? -1 : e.deltaY < 0 ? 1 : 0;
    if (hScroll === 0 && vScroll === 0) return;

    sendToTargets((t) => {
      const { x, y, w, h } = mapNormToDeviceXY(t.canvas, x01, y01);
      return encodeScrollMessage(x, y, w, h, hScroll, vScroll);
    });
  }

  const preventContextMenu = (e: Event) => e.preventDefault();

  canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
  canvas.addEventListener('pointermove', onPointerMove, { passive: false });
  canvas.addEventListener('pointerup', onPointerUpOrCancel, { passive: false });
  canvas.addEventListener('pointercancel', onPointerUpOrCancel, { passive: false });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', preventContextMenu);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUpOrCancel);
    canvas.removeEventListener('pointercancel', onPointerUpOrCancel);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', preventContextMenu);
  };
}
