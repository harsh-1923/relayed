// Capture the next complete chord (SHORTCUTS.md §13.2).
//
// The recorder listens on document capture and stops propagation, which is
// what gives the recorder layer precedence over every command: while it is
// recording, no shortcut in the app fires. It is created only while recording
// and destroyed on every exit, so an unmounted row cannot leave a listener.
import { useCallback, useEffect, useRef, useState } from 'react';
import { HotkeyRecorder } from '../../../shared/shortcuts/tanstack-driver.ts';

export interface ShortcutRecorder {
  readonly recording: boolean;
  readonly start: () => void;
  readonly cancel: () => void;
}

/** `onRecord` receives a normalized chord; Escape, bare Backspace and unmount cancel. */
export function useShortcutRecorder(onRecord: (hotkey: string) => void): ShortcutRecorder {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<HotkeyRecorder | null>(null);
  const onRecordRef = useRef(onRecord);
  useEffect(() => { onRecordRef.current = onRecord; }, [onRecord]);

  const stop = useCallback(() => {
    recorderRef.current?.destroy();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  const start = useCallback(() => {
    if (recorderRef.current) return;
    const recorder = new HotkeyRecorder({
      onRecord: hotkey => {
        stop();
        // A bare Backspace records "" — treated as cancel, never as a chord.
        // The library's type says Hotkey, but the spike observed the empty string.
        if ((hotkey as string) !== '') onRecordRef.current(hotkey);
      },
      onCancel: stop,
    });
    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { recording, start, cancel: stop };
}
