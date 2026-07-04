import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Platform } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import ConfirmDialog from '../components/ConfirmDialog';
import { useTranslation } from './LanguageContext';
import { deletePostById, archivePostById, setPostConfirmHandler, type PostConfirmRequest } from '../lib/postActions';

// Themed delete/archive confirmation, replacing the old system Alert — a centered
// ConfirmDialog card (same family as BlockConfirm) with the spotlight-aware copy.
// Triggered through the postActions bridge, so confirmDeletePost/confirmArchivePost
// callers (the 3-dot menu, long-press, the archive screen) stay unchanged.
export function PostConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [req, setReq] = useState<PostConfirmRequest | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPostConfirmHandler((r) => { setReq(r); setBusy(false); setVisible(true); });
    return () => setPostConfirmHandler(null);
  }, []);

  const isDelete = req?.kind === 'delete';
  const spot = !!req?.spotlighted;
  const title = !req ? '' : isDelete
    ? t(spot ? 'postAction.deleteTitleSpot' : 'postAction.deleteTitle')
    : t(spot ? 'postAction.archiveTitleSpot' : 'postAction.archiveTitle');
  const message = !req ? '' : isDelete
    ? t(spot ? 'postAction.deleteBodySpot' : 'postAction.deleteBody')
    : t(spot ? 'postAction.archiveBodySpot' : 'postAction.archiveBody');
  const confirmLabel = isDelete ? t('common.delete') : t('postAction.archiveBtn');

  function close() { setVisible(false); setReq(null); }

  async function onConfirm() {
    const r = req;
    if (!r || busy) return;
    setBusy(true);
    const ok = r.kind === 'delete' ? await deletePostById(r.postId) : await archivePostById(r.postId);
    setVisible(false);
    setReq(null);
    setBusy(false);
    if (ok) r.onDone?.();
    else Alert.alert(t('common.error'), t(r.kind === 'delete' ? 'postAction.deleteError' : 'postAction.archiveError'));
  }

  const dialog = (
    <ConfirmDialog
      visible={visible}
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      destructive={isDelete}
      icon={isDelete ? 'trash-outline' : 'archive-outline'}
      onConfirm={onConfirm}
      onCancel={close}
    />
  );

  // iOS hosts the overlay above the player/overlay chrome (mirrors BlockConfirm);
  // Android renders the absolute-fill dialog inline.
  return (
    <>
      {children}
      {Platform.OS === 'ios' ? <FullWindowOverlay>{dialog}</FullWindowOverlay> : dialog}
    </>
  );
}
