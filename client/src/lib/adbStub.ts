/**
 * ADB stub layer (console-only)
 *
 * The UI can call these functions today without having a backend.
 * Later you can replace internals with real API calls.
 */

import { readPageParams } from '@/lib/params';
import { pullFile as serverPullFile, pushFile as serverPushFile } from '@/lib/serverApi';

export type AdbTarget = {
  udids: string[];
};

function getWsServer(): string {
  try {
    return readPageParams().wsServer;
  } catch {
    return 'ws://127.0.0.1:11000/';
  }
}

function downloadBlob(blob: Blob, filename: string) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

function log(action: string, payload: unknown) {
  // Keep the log format stable so you can grep / build API later.
  // eslint-disable-next-line no-console
  console.log(`[ADB] ${action}`, payload);
}

export async function adbReboot(target: AdbTarget) {
  log('reboot', target);
}

export async function adbSetRotation(target: AdbTarget, rotation: 0 | 1 | 2 | 3) {
  log('set_rotation', { ...target, rotation });
}

export async function adbSetBrightness(target: AdbTarget, value01: number) {
  const v = Math.max(0, Math.min(1, value01));
  log('set_brightness', { ...target, value01: v });
}

export async function adbOpenUrl(target: AdbTarget, url: string) {
  log('open_url', { ...target, url });
}

export async function adbInputText(target: AdbTarget, text: string) {
  log('input_text', { ...target, text });
}

export async function adbStartApp(target: AdbTarget, pkg: string, activity?: string) {
  log('start_app', { ...target, pkg, activity: activity ?? '' });
}

export async function adbStopApp(target: AdbTarget, pkg: string) {
  log('stop_app', { ...target, pkg });
}

export async function adbUninstall(target: AdbTarget, pkg: string) {
  log('uninstall', { ...target, pkg });
}

export async function adbInstallApk(target: AdbTarget, file: File) {
  log('install_apk', {
    ...target,
    file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
  });
}

export async function adbPushFile(target: AdbTarget, file: File, remotePath: string) {
  log('push_file', {
    ...target,
    remotePath,
    file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
  });

  const wsServer = getWsServer();
  // Push to each device sequentially (keeps memory + backpressure sane)
  for (const udid of target.udids) {
    await serverPushFile(wsServer, udid, file, remotePath);
  }
}

export async function adbPullFile(target: AdbTarget, remotePath: string) {
  log('pull_file', { ...target, remotePath });

  const wsServer = getWsServer();
  for (const udid of target.udids) {
    const blob = await serverPullFile(wsServer, udid, remotePath);
    const base = remotePath.split('/').filter(Boolean).pop() || 'file.bin';
    downloadBlob(blob, `${udid}_${base}`);
  }
}

export async function adbTakeScreenshot(target: AdbTarget) {
  log('screencap', target);
}

// Track screenrecord state per-device to avoid double-start.
const recordingUdids = new Set<string>();

export async function adbStartScreenRecord(target: AdbTarget, opts?: { bitrate?: number; maxSec?: number }) {
  // If any requested device is already recording, reject to keep "1 recording per device" invariant.
  const busy = target.udids.find((u) => recordingUdids.has(u));
  if (busy) {
    throw new Error(`Device ${busy} is already recording`);
  }

  log('screenrecord_start', { ...target, opts: opts ?? {} });

  // Mark all target devices as recording.
  target.udids.forEach((u) => recordingUdids.add(u));
}

export async function adbStopScreenRecord(target: AdbTarget) {
  log('screenrecord_stop', target);

  // Clear recording flags on stop.
  target.udids.forEach((u) => recordingUdids.delete(u));
}
