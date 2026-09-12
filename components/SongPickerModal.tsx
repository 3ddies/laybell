import {
  View, Text, StyleSheet, Modal, TouchableOpacity, Keyboard, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import SongBrowser, { type PickedSong } from './SongBrowser';

export type { PickedSong } from './SongBrowser';

// Pick another creator's track to use on your image, slideshow or story, as a
// sheet. The list itself — All / Liked / Yours, search, preview, like — is
// components/SongBrowser, which the video studio shows inline instead.
export default function SongPickerModal({ visible, onClose, onSelect, ownOnly = false }: {
  visible: boolean;
  onClose: () => void;
  onSelect: (song: PickedSong) => void;
  /**
   * Music-video mode: offer ONLY songs this user made or is credited on, and
   * drop the tabs (the others are other people's tracks, which is the opposite of
   * what "a song currently on my page" means).
   */
  ownOnly?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  function pick(song: PickedSong) {
    onSelect(song);
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Lift the sheet clear of the keyboard. Without this the sheet keeps its
          full height and the keyboard simply covers it: the search field ended up
          sitting directly on top of the keyboard with NO list left visible, so
          you were typing a search you could not see the results of. */}
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
          {/* Tapping the sheet itself has to be swallowed so it does not reach the
              overlay and close the picker — and that same dead tap puts the
              keyboard away, so any inert part of the sheet is a way out of the
              keyboard without losing the search you typed. */}
          <TouchableOpacity style={styles.sheet} activeOpacity={1} onPress={() => Keyboard.dismiss()}>
            <View style={styles.handle} />
            <View style={styles.head}>
              <Text style={styles.title}>{t('songPicker.title')}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            {/* Mounted only while open, so closing resets the tab, the search and
                the lists — and stops any preview. */}
            {visible && <SongBrowser ownOnly={ownOnly} onPick={pick} />}
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  fill: { flex: 1 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    height: '80%', paddingBottom: SPACING.xl,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: SPACING.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
});
