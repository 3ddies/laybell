import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useOffline, type PinInput, type PinOutcome } from '../contexts/OfflineContext';
import { useProfile } from '../contexts/ProfileContext';
import { useTranslation } from '../contexts/LanguageContext';
import { rawTier, tierLabel } from '../lib/badges';

// One place every download button goes through, so the affordance behaves
// identically in TrackRow, the 3-dot menu, NowPlaying, the Downloads screen, etc.:
// it pins the track and maps any failure to the right localized alert (tier limit,
// no space, storage cap, artist opt-out, …). Components just call download(track).

export function useDownloadAction() {
  const offline = useOffline();
  const { profile } = useProfile();
  const { t } = useTranslation();

  const download = useCallback(async (input: PinInput): Promise<PinOutcome> => {
    const outcome = await offline.pin(input);
    switch (outcome) {
      case 'ok':
      case 'web':
      case 'noauth':
        break;
      case 'limit': {
        const tier = rawTier(profile);
        Alert.alert(
          t('offline.pinLimitTitle'),
          tier
            ? t('offline.pinLimitTiered', { tier: tierLabel(tier), count: offline.pinLimit })
            : t('offline.pinLimitNoBadge', { count: offline.pinLimit }),
        );
        break;
      }
      case 'space':
        Alert.alert(t('offline.spaceTitle'), t('offline.spaceBody'));
        break;
      case 'cap':
        Alert.alert(t('offline.capTitle'), t('offline.capBody'));
        break;
      case 'optout':
        Alert.alert(t('offline.optOutTitle'), t('offline.optOutBody'));
        break;
      case 'error':
      default:
        Alert.alert(t('offline.errorTitle'), t('offline.errorBody'));
        break;
    }
    return outcome;
  }, [offline, profile, t]);

  const confirmRemove = useCallback((postId: string, title?: string) => {
    Alert.alert(
      t('offline.removeConfirmTitle'),
      t('offline.removeConfirmBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('offline.removeAction'), style: 'destructive', onPress: () => { offline.remove(postId); } },
      ],
    );
  }, [offline, t]);

  return {
    download,
    confirmRemove,
    isPinned: offline.isPinned,
    isDownloading: offline.isDownloading,
    progress: offline.progress,
  };
}
