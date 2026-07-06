import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Image, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../components/SwipeBackPager';
import { RADIUS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  LISTING_CATEGORIES, buyerTaxCents, createListing, fetchListing, formatPrice,
  sellerEarningsCents, shopFeeCents, updateListing,
  uploadListingCover, uploadListingFile, uploadListingPreview,
  type ListingCategory, type ListingLicense,
} from '../../lib/shop';

// Create / edit a listing. Three media slots:
//   cover   — square image (public)
//   preview — short/tagged audio anyone can stream (public)
//   file    — the real deliverable, unlocked per-buyer on delivery (private)

type PickedAudio = { uri: string; name: string; mime: string } | null;

export default function NewListingScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id: editId } = useLocalSearchParams<{ id?: string }>();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<ListingCategory>('beat');
  const [genre, setGenre] = useState('');
  const [price, setPrice] = useState('');
  const [license, setLicense] = useState<ListingLicense>('nonexclusive');
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [existingCover, setExistingCover] = useState<string | null>(null);
  const [preview, setPreview] = useState<PickedAudio>(null);
  const [hasExistingPreview, setHasExistingPreview] = useState(false);
  const [file, setFile] = useState<PickedAudio>(null);
  const [hasExistingFile, setHasExistingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit mode: seed the form from the listing.
  const seed = useCallback(async () => {
    if (!editId) return;
    const l = await fetchListing(editId).catch(() => null);
    if (!l) return;
    setTitle(l.title);
    setDescription(l.description ?? '');
    setCategory(l.category);
    setGenre(l.genre ?? '');
    setPrice(l.price_cents > 0 ? String(l.price_cents / 100) : '');
    setLicense(l.license);
    setExistingCover(l.cover_url);
    setHasExistingPreview(!!l.preview_url);
    setHasExistingFile(!!l.file_path);
  }, [editId]);
  useEffect(() => { seed(); }, [seed]);

  async function pickCover() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'] as never,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) setCoverUri(result.assets[0].uri);
  }

  async function pickAudio(kind: 'preview' | 'file') {
    const result = await DocumentPicker.getDocumentAsync({
      type: kind === 'preview' ? 'audio/*' : '*/*',
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const a = result.assets[0];
    const picked = { uri: a.uri, name: a.name ?? 'file', mime: a.mimeType ?? 'application/octet-stream' };
    if (kind === 'preview') setPreview(picked);
    else setFile(picked);
  }

  const priceCents = Math.round((parseFloat(price.replace(',', '.')) || 0) * 100);
  const canPublish =
    !!title.trim() && !busy
    && (license === 'free' || priceCents > 0)
    && (hasExistingFile || !!file || category === 'service');

  async function publish() {
    if (!canPublish) return;
    setBusy(true);
    setError(null);
    try {
      let listingId = editId ?? '';
      if (editId) {
        await updateListing(editId, {
          title: title.trim(),
          description: description.trim() || null,
          category,
          genre: genre.trim() || null,
          price_cents: license === 'free' ? 0 : priceCents,
          license,
        });
      } else {
        const created = await createListing({
          title, description, category, genre,
          priceCents, license,
        });
        listingId = created.id;
      }
      const media: Partial<{ cover_url: string; preview_url: string; file_path: string }> = {};
      if (coverUri) media.cover_url = await uploadListingCover(listingId, coverUri);
      if (preview) media.preview_url = await uploadListingPreview(listingId, preview.uri, preview.mime);
      if (file) media.file_path = await uploadListingFile(listingId, file.uri, file.mime, file.name);
      if (Object.keys(media).length) await updateListing(listingId, media);
      router.back();
    } catch {
      setError(t('shop.error'));
    }
    setBusy(false);
  }

  const coverShown = coverUri ?? existingCover;

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{editId ? t('shop.editListing') : t('shop.newListing')}</Text>
          <View style={styles.headerBtn} />
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Cover */}
          <TouchableOpacity style={styles.coverPick} onPress={pickCover} activeOpacity={0.85}>
            {coverShown ? (
              <Image source={{ uri: coverShown }} style={styles.coverImg} />
            ) : (
              <View style={styles.coverEmpty}>
                <Ionicons name="image-outline" size={30} color={colors.textTertiary} />
                <Text style={styles.coverEmptyText}>{t('shop.addCover')}</Text>
              </View>
            )}
          </TouchableOpacity>

          <TextInput
            style={styles.input}
            placeholder={t('shop.titlePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={title}
            onChangeText={setTitle}
            maxLength={80}
          />
          <TextInput
            style={[styles.input, styles.inputMultiline]}
            placeholder={t('shop.descPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={description}
            onChangeText={setDescription}
            multiline
            maxLength={1000}
          />

          {/* Category */}
          <Text style={styles.label}>{t('shop.categoryLabel')}</Text>
          <View style={styles.chipWrap}>
            {LISTING_CATEGORIES.map((cat) => (
              <TouchableOpacity
                key={cat}
                style={[styles.chip, category === cat && styles.chipActive]}
                onPress={() => setCategory(cat)}
              >
                <Text style={[styles.chipText, category === cat && styles.chipTextActive]}>
                  {t(`shop.category.${cat}`)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TextInput
            style={styles.input}
            placeholder={t('shop.genrePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={genre}
            onChangeText={setGenre}
            maxLength={40}
          />

          {/* License + price */}
          <Text style={styles.label}>{t('shop.licenseLabel')}</Text>
          <View style={styles.chipWrap}>
            {(['nonexclusive', 'exclusive', 'free'] as ListingLicense[]).map((lic) => (
              <TouchableOpacity
                key={lic}
                style={[styles.chip, license === lic && styles.chipActive]}
                onPress={() => setLicense(lic)}
              >
                <Text style={[styles.chipText, license === lic && styles.chipTextActive]}>
                  {t(`shop.license.${lic}`)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {license !== 'free' && (
            <>
              <View style={styles.priceRow}>
                <Text style={styles.priceSymbol}>$</Text>
                <TextInput
                  style={[styles.input, styles.priceInput]}
                  placeholder="0.00"
                  placeholderTextColor={colors.textTertiary}
                  value={price}
                  onChangeText={setPrice}
                  keyboardType="decimal-pad"
                  maxLength={9}
                />
              </View>
              {/* Poshmark-style earnings breakdown — live as the price is typed. */}
              {priceCents > 0 && (
                <View style={styles.earnCard}>
                  <View style={styles.earnRow}>
                    <Text style={styles.earnLabel}>{t('shop.earnPrice')}</Text>
                    <Text style={styles.earnValue}>{formatPrice(priceCents)}</Text>
                  </View>
                  <View style={styles.earnRow}>
                    <Text style={styles.earnLabel}>{t('shop.earnFee')}</Text>
                    <Text style={styles.earnValue}>−{formatPrice(shopFeeCents(priceCents))}</Text>
                  </View>
                  <View style={styles.earnRow}>
                    <Text style={styles.earnLabel}>{t('shop.earnTax')}</Text>
                    <Text style={styles.earnValueMuted}>+{formatPrice(buyerTaxCents(priceCents))}</Text>
                  </View>
                  <View style={styles.earnDivider} />
                  <View style={styles.earnRow}>
                    <Text style={styles.earnTotalLabel}>{t('shop.earnYou')}</Text>
                    <Text style={styles.earnTotalValue}>{formatPrice(sellerEarningsCents(priceCents))}</Text>
                  </View>
                  <Text style={styles.earnNote}>{t('shop.earnNote')}</Text>
                </View>
              )}
            </>
          )}

          {/* Audio slots */}
          <Text style={styles.label}>{t('shop.mediaLabel')}</Text>
          <TouchableOpacity style={styles.fileRow} onPress={() => pickAudio('preview')}>
            <Ionicons name="volume-medium-outline" size={19} color={colors.text} />
            <View style={styles.flex}>
              <Text style={styles.fileTitle}>{t('shop.previewAudio')}</Text>
              <Text style={styles.fileSub} numberOfLines={1}>
                {preview?.name ?? (hasExistingPreview ? t('shop.mediaKept') : t('shop.previewAudioSub'))}
              </Text>
            </View>
            <Ionicons name={preview || hasExistingPreview ? 'checkmark-circle' : 'add-circle-outline'} size={20} color={preview || hasExistingPreview ? colors.success : colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.fileRow} onPress={() => pickAudio('file')}>
            <Ionicons name="lock-closed-outline" size={19} color={colors.text} />
            <View style={styles.flex}>
              <Text style={styles.fileTitle}>{t('shop.deliverable')}</Text>
              <Text style={styles.fileSub} numberOfLines={1}>
                {file?.name ?? (hasExistingFile ? t('shop.mediaKept') : t('shop.deliverableSub'))}
              </Text>
            </View>
            <Ionicons name={file || hasExistingFile ? 'checkmark-circle' : 'add-circle-outline'} size={20} color={file || hasExistingFile ? colors.success : colors.textTertiary} />
          </TouchableOpacity>

          {!!error && <Text style={styles.error}>{error}</Text>}
          <TouchableOpacity
            style={[styles.greenBtn, !canPublish && { opacity: 0.5 }]}
            onPress={publish}
            disabled={!canPublish}
            activeOpacity={0.85}
          >
            {busy ? <ActivityIndicator color="#fff" /> : (
              <Text style={styles.greenBtnText}>{editId ? t('shop.saveListing') : t('shop.publish')}</Text>
            )}
          </TouchableOpacity>
          {/* Rights attestation — publishing is the act of confirming ownership. */}
          <Text style={styles.rightsNote}>{t('shop.rightsNote')}</Text>
        </ScrollView>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '700' },
  content: { padding: SPACING.md, gap: 10, paddingBottom: 46 },
  coverPick: { alignSelf: 'center', width: 160, height: 160, borderRadius: RADIUS.lg, overflow: 'hidden', backgroundColor: c.surfaceLight },
  coverImg: { width: '100%', height: '100%' },
  coverEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  coverEmptyText: { color: c.textTertiary, fontSize: 12, fontWeight: '600' },
  input: {
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md,
    paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 15,
  },
  inputMultiline: { minHeight: 84, textAlignVertical: 'top' },
  label: { color: c.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 6 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: RADIUS.full, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 7 },
  chipActive: { backgroundColor: c.text, borderColor: c.text },
  chipText: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: c.background },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  priceSymbol: { color: c.text, fontSize: 18, fontWeight: '800' },
  priceInput: { flex: 1 },
  earnCard: {
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    padding: 12, gap: 7,
  },
  earnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  earnLabel: { color: c.textSecondary, fontSize: 13 },
  earnValue: { color: c.text, fontSize: 13, fontWeight: '600' },
  earnValueMuted: { color: c.textTertiary, fontSize: 13, fontWeight: '600' },
  earnDivider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 2 },
  earnTotalLabel: { color: c.text, fontSize: 14, fontWeight: '800' },
  earnTotalValue: { color: c.success, fontSize: 16, fontWeight: '800' },
  earnNote: { color: c.textTertiary, fontSize: 11, lineHeight: 15, marginTop: 2 },
  fileRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 12,
  },
  fileTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  fileSub: { color: c.textTertiary, fontSize: 12, marginTop: 1 },
  greenBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.success, borderRadius: RADIUS.full, paddingVertical: 14, marginTop: 6,
  },
  greenBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  error: { color: c.error, fontSize: 13, textAlign: 'center' },
  rightsNote: { color: c.textTertiary, fontSize: 11, lineHeight: 15, textAlign: 'center', paddingHorizontal: 14 },
});
