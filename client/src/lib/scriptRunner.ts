import {
  encodeKeycodeMessage,
  encodeTextMessage,
  encodeTouchMessage,
  KeyEventAction,
  MotionAction,
} from '@/lib/control';
import type { InputTarget } from '@/context/ActiveContext';

export type ScriptStep =
  | { type: 'wait'; ms: number }
  | { type: 'tap'; x01: number; y01: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  | { type: 'key'; keycode: number }
  | { type: 'text'; text: string };

export type ParsedScript = {
  steps: ScriptStep[];
  errors: string[];
};

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mapNormToDeviceXY(targetCanvas: HTMLCanvasElement, x01: number, y01: number) {
  const w = targetCanvas.width || 1;
  const h = targetCanvas.height || 1;
  const x = Math.max(0, Math.min(w, Math.round(x01 * w)));
  const y = Math.max(0, Math.min(h, Math.round(y01 * h)));
  return { x, y, w, h };
}

function sendSafe(t: InputTarget, u8: Uint8Array) {
  try {
    if (!t.ws || t.ws.readyState !== WebSocket.OPEN) return;
    t.ws.send(u8);
  } catch {
    // ignore
  }
}

export function parseScriptDsl(dsl: string, keyNameToCode: Record<string, number>): ParsedScript {
  const steps: ScriptStep[] = [];
  const errors: string[] = [];
  const lines = (dsl ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('//')) continue;

    const parts = line.split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();

    const errPrefix = `Line ${i + 1}:`;
    const n = (x: string) => Number(x);

    if (cmd === 'wait') {
      const ms = n(parts[1] ?? '');
      if (!Number.isFinite(ms) || ms < 0) errors.push(`${errPrefix} wait <ms>`);
      else steps.push({ type: 'wait', ms: Math.floor(ms) });
      continue;
    }

    if (cmd === 'tap') {
      const x01 = n(parts[1] ?? '');
      const y01 = n(parts[2] ?? '');
      if (!Number.isFinite(x01) || !Number.isFinite(y01)) errors.push(`${errPrefix} tap <x01> <y01>`);
      else steps.push({ type: 'tap', x01: clamp01(x01), y01: clamp01(y01) });
      continue;
    }

    if (cmd === 'swipe') {
      const x1 = n(parts[1] ?? '');
      const y1 = n(parts[2] ?? '');
      const x2 = n(parts[3] ?? '');
      const y2 = n(parts[4] ?? '');
      const dur = n(parts[5] ?? '');
      if (![x1, y1, x2, y2, dur].every((v) => Number.isFinite(v))) {
        errors.push(`${errPrefix} swipe <x1> <y1> <x2> <y2> <durationMs>`);
      } else {
        steps.push({
          type: 'swipe',
          x1: clamp01(x1),
          y1: clamp01(y1),
          x2: clamp01(x2),
          y2: clamp01(y2),
          durationMs: Math.max(0, Math.floor(dur)),
        });
      }
      continue;
    }

    if (cmd === 'key') {
      const keyRaw = (parts[1] ?? '').trim();
      if (!keyRaw) {
        errors.push(`${errPrefix} key <KEYCODE|NAME>`);
        continue;
      }
      const asNum = Number(keyRaw);
      if (Number.isFinite(asNum)) {
        steps.push({ type: 'key', keycode: Math.floor(asNum) });
        continue;
      }
      const k = keyRaw.toUpperCase();
      const code = keyNameToCode[k];
      if (!Number.isFinite(code)) errors.push(`${errPrefix} unknown key name "${keyRaw}"`);
      else steps.push({ type: 'key', keycode: code });
      continue;
    }

    if (cmd === 'text') {
      // Keep spaces: everything after first space is the text.
      const text = raw.slice(raw.indexOf(' ') + 1);
      if (!text || text.trim().length === 0) errors.push(`${errPrefix} text <your text...>`);
      else steps.push({ type: 'text', text });
      continue;
    }

    errors.push(`${errPrefix} unknown command "${parts[0]}"`);
  }

  return { steps, errors };
}

export async function runScript(
  targets: InputTarget[],
  steps: ScriptStep[],
  opts?: { signal?: AbortSignal; log?: (msg: string) => void },
) {
  const log = opts?.log ?? (() => {});
  if (!targets.length) return;

  for (const step of steps) {
    if (opts?.signal?.aborted) {
      log('⛔️ Script aborted');
      return;
    }

    if (step.type === 'wait') {
      log(`wait ${step.ms}`);
      await sleep(step.ms);
      continue;
    }

    if (step.type === 'key') {
      log(`key ${step.keycode}`);
      for (const t of targets) {
        sendSafe(t, encodeKeycodeMessage(KeyEventAction.DOWN, step.keycode));
        sendSafe(t, encodeKeycodeMessage(KeyEventAction.UP, step.keycode));
      }
      await sleep(50);
      continue;
    }

    if (step.type === 'text') {
      log(`text (${step.text.length} chars)`);
      const u8 = encodeTextMessage(step.text);
      for (const t of targets) sendSafe(t, u8);
      await sleep(80);
      continue;
    }

    if (step.type === 'tap') {
      log(`tap ${step.x01.toFixed(3)} ${step.y01.toFixed(3)}`);
      for (const t of targets) {
        const { x, y, w, h } = mapNormToDeviceXY(t.canvas, step.x01, step.y01);
        sendSafe(t, encodeTouchMessage(MotionAction.DOWN, 0, x, y, w, h, 1, 1));
      }
      await sleep(60);
      for (const t of targets) {
        const { x, y, w, h } = mapNormToDeviceXY(t.canvas, step.x01, step.y01);
        sendSafe(t, encodeTouchMessage(MotionAction.UP, 0, x, y, w, h, 0, 0));
      }
      await sleep(80);
      continue;
    }

    if (step.type === 'swipe') {
      const nMoves = Math.max(3, Math.min(30, Math.round(step.durationMs / 40)));
      log(
        `swipe ${step.x1.toFixed(3)} ${step.y1.toFixed(3)} -> ${step.x2.toFixed(3)} ${step.y2.toFixed(3)} (${step.durationMs}ms)`,
      );
      for (const t of targets) {
        const { x, y, w, h } = mapNormToDeviceXY(t.canvas, step.x1, step.y1);
        sendSafe(t, encodeTouchMessage(MotionAction.DOWN, 0, x, y, w, h, 1, 1));
      }

      const start = Date.now();
      for (let i = 1; i < nMoves; i++) {
        if (opts?.signal?.aborted) return;
        const a = i / (nMoves - 1);
        const x01 = step.x1 + (step.x2 - step.x1) * a;
        const y01 = step.y1 + (step.y2 - step.y1) * a;
        for (const t of targets) {
          const { x, y, w, h } = mapNormToDeviceXY(t.canvas, x01, y01);
          sendSafe(t, encodeTouchMessage(MotionAction.MOVE, 0, x, y, w, h, 1, 1));
        }
        const elapsed = Date.now() - start;
        const targetElapsed = (step.durationMs * i) / (nMoves - 1);
        const wait = Math.max(0, Math.round(targetElapsed - elapsed));
        if (wait) await sleep(wait);
      }

      for (const t of targets) {
        const { x, y, w, h } = mapNormToDeviceXY(t.canvas, step.x2, step.y2);
        sendSafe(t, encodeTouchMessage(MotionAction.UP, 0, x, y, w, h, 0, 0));
      }
      await sleep(120);
      continue;
    }
  }

  log('✅ Script done');
}
