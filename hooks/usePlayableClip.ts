import { useCallback, useEffect, useState } from 'react';
import { ensureLocalFile, insideAppSandbox } from '../lib/upload';

// A picked clip, made playable for an editor.
//
// A camera-roll pick is a file:// URL into the Photos store, and iOS gives the
// app only limited access to it: AVFoundation opens the container but finds no
// readable track — a black screen, which is exactly what the caption editor's
// first device test showed (lib/upload.ts ensureLocalFile has the full story). A
// copy inside the app's own storage plays. It is the copy the upload makes
// anyway, under the same stable name, so a clip is copied once for everything.
//
// A POSTED video, reopened to edit, is a stream every player in the app already
// opens directly: an http(s) source goes straight through, with nothing to copy.
//
// Kept per source, so reopening an editor on the same clip plays at once.
// `tag` prefixes the dev-build log lines, so a device test reads off the log.
export function usePlayableClip(active: boolean, sourceUri: string | null, tag: string) {
  const remote = !!sourceUri && /^https?:\/\//i.test(sourceUri);
  const [clip, setClip] = useState<{ source: string; local: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (remote || !active || !sourceUri || clip?.source === sourceUri) return;
    let cancelled = false;
    const began = Date.now();
    setFailed(false);
    setPreparing(true);
    ensureLocalFile(sourceUri)
      .then((local) => {
        if (cancelled) return;
        if (insideAppSandbox(local)) {
          setClip({ source: sourceUri, local });
          // eslint-disable-next-line no-console
          if (__DEV__) console.log(`[${tag}] playing a copy in app storage (${Date.now() - began} ms)`);
        } else {
          setFailed(true);
          // eslint-disable-next-line no-console
          if (__DEV__) console.log(`[${tag}] could not copy the clip into app storage — showing the poster`);
        }
      })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setPreparing(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sourceUri]);

  const markFailed = useCallback(() => setFailed(true), []);
  const uri = remote ? sourceUri : clip && clip.source === sourceUri ? clip.local : null;
  return { uri, failed, preparing: remote ? false : preparing, markFailed };
}
