import { useCallback, useState } from 'react';
import { ShareSheet, type SharePayload } from '../contexts/ShareContext';
import { PostOptionsSheet, type PostOptionsArgs } from '../contexts/PostOptionsContext';
import AddToPlaylistModal from '../components/AddToPlaylistModal';

// The global Share / Post-options sheets are <Modal>s mounted once at the root.
// That works on normal (tab) screens, but the post & reel detail routes are
// `presentation: 'transparentModal'` — their own native modal VC on iOS — and
// iOS won't present a second modal over one that's already showing, so those
// root sheets silently never appear there (while CommentsSheet, rendered inside
// the route, does).
//
// This hook hosts LOCAL copies of the sheets inside the screen, so they present
// from the route's own VC. Drop `sheets` into the screen's tree and call the
// returned `share` / `showOptions` exactly like the context versions.
export function usePostActionSheets() {
  const [sharePayload, setSharePayload] = useState<SharePayload | null>(null);
  const [shareVisible, setShareVisible] = useState(false);
  const [optsArgs, setOptsArgs] = useState<PostOptionsArgs | null>(null);
  const [optsVisible, setOptsVisible] = useState(false);
  const [playlistPostId, setPlaylistPostId] = useState<string | null>(null);

  const share = useCallback((p: SharePayload) => { setSharePayload(p); setShareVisible(true); }, []);
  const showOptions = useCallback((o: PostOptionsArgs) => { setOptsArgs(o); setOptsVisible(true); }, []);

  const sheets = (
    <>
      <ShareSheet visible={shareVisible} payload={sharePayload} onClose={() => setShareVisible(false)} />
      <PostOptionsSheet
        visible={optsVisible}
        opts={optsArgs}
        onClose={() => setOptsVisible(false)}
        onAddToPlaylist={setPlaylistPostId}
      />
      <AddToPlaylistModal
        visible={!!playlistPostId}
        postId={playlistPostId ?? ''}
        onClose={() => setPlaylistPostId(null)}
      />
    </>
  );

  return { share, showOptions, sheets };
}
