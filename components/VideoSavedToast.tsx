import { useEffect, useState } from 'react';
import Toast from './Toast';
import { useTranslation } from '../contexts/LanguageContext';
import { openAppSettings } from '../lib/permissions';
import { subscribeVideoSaves, type SaveStatus } from '../lib/videoExport';

// Save to camera roll works quietly (the owner's call, 2026-09-11): nothing while a
// finished video is being saved, nothing once it's there. The only thing said is
// that a copy the switch promised couldn't be made — and, for a denied permission,
// a tap to Settings. Mounted with the app's other overlays, lifted clear of the tab bar.

type Failure = Extract<SaveStatus, { phase: 'failed' }>;

export default function VideoSavedToast() {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<{ id: number; value: Failure } | null>(null);

  useEffect(() => {
    let id = 0;
    return subscribeVideoSaves((status) => {
      if (status.phase === 'failed') setFailure({ id: ++id, value: status });
    });
  }, []);

  if (!failure) return null;
  const { id, value } = failure;
  return (
    <Toast
      // Each failure mounts its own toast, with its own timer.
      key={id}
      visible
      icon="alert-circle"
      title={t('saveVideo.failedTitle')}
      message={value.reason === 'permission'
        ? t('saveVideo.permissionBody')
        : value.reason === 'interrupted' ? t('saveVideo.interruptedBody') : undefined}
      duration={3600}
      bottomOffset={96}
      onPress={value.reason === 'permission' ? () => { openAppSettings(); } : undefined}
      onHide={() => setFailure((current) => (current && current.id === id ? null : current))}
    />
  );
}
