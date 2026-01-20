import { useEffect, useRef } from 'react';
import { encodeKeycodeMessage, encodeTextMessage, KeyEventAction } from '@/lib/control';
import { AndroidKeycode, KeyToCodeMap } from '@/lib/keyEvent';
import { useActive } from '@/context/ActiveContext';

type GlobalWithToggle = typeof window & { __disableDirectKeyboard?: boolean };

export function useDirectKeyboard(enabled: boolean, allowedContainer?: HTMLElement | null) {
  const { sendToActive } = useActive();

  // buffer text (optional quick input)
  const kbBufRef = useRef('');
  const flushTimerRef = useRef<number | null>(null);
  const repeatCounterRef = useRef<Map<number, number>>(new Map());

  function flushText() {
    const buf = kbBufRef.current;
    if (!buf) return;
    sendToActive(encodeTextMessage(buf));
    kbBufRef.current = '';
    flushTimerRef.current = null;
  }

  function queueText(s: string) {
    kbBufRef.current += s;
    if (flushTimerRef.current != null) return;
    flushTimerRef.current = window.setTimeout(flushText, 35);
  }

  useEffect(() => {
    // cleanup any pending timer when disabling
    if (!enabled) {
      kbBufRef.current = '';
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      repeatCounterRef.current.clear();
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabled || (window as GlobalWithToggle).__disableDirectKeyboard) return;

      // Allow typing into the on-screen input/textarea
      if (allowedContainer && e.target instanceof Node && allowedContainer.contains(e.target)) {
        return;
      }

      const isWin = e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight';
      const isAlt = e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight';
      const isCtrl = e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight';
      const isTab = e.key === 'Tab';
      const isFn = e.key === 'Fn' || e.code === 'Fn';

      const hasModifierCombo = e.altKey || e.ctrlKey || e.metaKey; // Shift still allowed

      if (isWin || isAlt || isCtrl || isFn || hasModifierCombo || isTab) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
      }

      // Map physical key code -> Android keycode
      const keyCode = KeyToCodeMap.get(e.code) ?? null;
      if (keyCode == null) {
        // For printable chars not in mapping, you can optionally send text.
        // This matches original behaviour (it just ignores unknown keys).
        return;
      }

      let repeatCount = 0;
      if (e.repeat) {
        const prev = repeatCounterRef.current.get(keyCode) ?? 0;
        const next = prev <= 0 ? 1 : prev + 1;
        repeatCount = next;
        repeatCounterRef.current.set(keyCode, next);
      }

      const metaState =
        (e.getModifierState('Alt') ? AndroidKeycode.META_ALT_ON : 0) |
        (e.getModifierState('Shift') ? AndroidKeycode.META_SHIFT_ON : 0) |
        (e.getModifierState('Control') ? AndroidKeycode.META_CTRL_ON : 0) |
        (e.getModifierState('Meta') ? AndroidKeycode.META_META_ON : 0) |
        (e.getModifierState('CapsLock') ? AndroidKeycode.META_CAPS_LOCK_ON : 0) |
        (e.getModifierState('ScrollLock') ? AndroidKeycode.META_SCROLL_LOCK_ON : 0) |
        (e.getModifierState('NumLock') ? AndroidKeycode.META_NUM_LOCK_ON : 0);

      sendToActive(encodeKeycodeMessage(KeyEventAction.DOWN, keyCode, repeatCount, metaState));
      e.preventDefault();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!enabled || (window as GlobalWithToggle).__disableDirectKeyboard) return;

      if (allowedContainer && e.target instanceof Node && allowedContainer.contains(e.target)) {
        return;
      }

      const isWin = e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight';
      const isAlt = e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight';
      const isCtrl = e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight';
      const isFn = e.key === 'Fn' || e.code === 'Fn';
      const hasModifierCombo = e.altKey || e.ctrlKey || e.metaKey;

      if (isWin || isAlt || isCtrl || isFn || hasModifierCombo) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
      }

      const keyCode = KeyToCodeMap.get(e.code) ?? null;
      if (keyCode == null) return;
      repeatCounterRef.current.delete(keyCode);

      const metaState =
        (e.getModifierState('Alt') ? AndroidKeycode.META_ALT_ON : 0) |
        (e.getModifierState('Shift') ? AndroidKeycode.META_SHIFT_ON : 0) |
        (e.getModifierState('Control') ? AndroidKeycode.META_CTRL_ON : 0) |
        (e.getModifierState('Meta') ? AndroidKeycode.META_META_ON : 0) |
        (e.getModifierState('CapsLock') ? AndroidKeycode.META_CAPS_LOCK_ON : 0) |
        (e.getModifierState('ScrollLock') ? AndroidKeycode.META_SCROLL_LOCK_ON : 0) |
        (e.getModifierState('NumLock') ? AndroidKeycode.META_NUM_LOCK_ON : 0);

      sendToActive(encodeKeycodeMessage(KeyEventAction.UP, keyCode, 0, metaState));
      e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown, { capture: true, passive: false });
    window.addEventListener('keyup', onKeyUp, { capture: true, passive: false });

    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true } as any);
      window.removeEventListener('keyup', onKeyUp, { capture: true } as any);
    };
  }, [enabled, allowedContainer, sendToActive]);

  return { queueText, flushText };
}
