import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Image, ActivityIndicator,
  Modal, FlatList, Switch,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../components/SwipeBackPager';
import { tabTick } from '../../lib/haptics';
import { RADIUS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { supabase } from '../../lib/supabase';
import {
  LISTING_CATEGORIES, buyerTaxCents, createListing, fetchListing, formatPrice, saleTypes,
  sellerEarningsCents, shopFeeCents, updateListing, updateListingTypes,
  uploadListingCover, uploadListingFile, uploadListingPreview,
  type ListingCategory, type ListingTypesInput,
} from '../../lib/shop';

// Create / edit a listing. Three media slots (cover / public preview / private
// deliverable) + MULTI-TYPE deals: the seller highlights any combination of
//   Sell  (exclusive buy-out, its own price)
//   Lease (non-exclusive copies, its own price)
//   Free  (a claim — optionally gated on following the seller and/or liking
//          any number of their posts)
// and the listing page grows one CTA button per highlighted type.

type PickedAudio = { uri: string; name: string; mime: string } | null;
type MyPost = { id: string; thumb: string | null };

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
  // Deal types — any combination.
  const [sellOn, setSellOn] = useState(false);
  const [leaseOn, setLeaseOn] = useState(true);
  const [freeOn, setFreeOn] = useState(false);
  const [sellPrice, setSellPrice] = useState('');
  const [leasePrice, setLeasePrice] = useState('');
  // Free-claim conditions.
  const [freeFollow, setFreeFollow] = useState(false);
  const [freePostIds, setFreePostIds] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [myPosts, setMyPosts] = useState<MyPost[] | null>(null);
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
    const types = saleTypes(l);
    setSellOn(types.sell);
    setLeaseOn(types.lease);
    setFreeOn(types.free);
    const sp = l.sell_enabled ? (l.sell_price_cents ?? 0) : types.sell ? l.price_cents : 0;
    const lp = l.lease_enabled ? (l.lease_price_cents ?? 0) : types.lease ? l.price_cents : 0;
    setSellPrice(sp > 0 ? String(sp / 100) : '');
    setLeasePrice(lp > 0 ? String(lp / 100) : '');
    setFreeFollow(!!l.free_requires_follow);
    setFreePostIds(l.free_like_post_ids ?? []);
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

  // My public posts, for the "must like these posts" condition picker.
  async function openPostPicker() {
    setPickerOpen(true);
    if (myPosts) return;
    try {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth?.user) { setMyPosts([]); return; }
      const { data } = await supabase
        .from('posts')
        .select('id, media_url, thumbnail_url, cover_url')
        .eq('user_id', auth.user.id)
        .eq('is_public', true)
        .order('created_at', { ascending: false })
        .limit(90);
      setMyPosts((data ?? []).map((p: Record<string, string | null>) => ({
        id: p.id as string,
        thumb: p.thumbnail_url || p.cover_url || p.media_url || null,
      })));
    } catch { setMyPosts([]); }
  }

  const sellPriceCents = Math.round((parseFloat(sellPrice.replace(',', '.')) || 0) * 100);
  const leasePriceCents = Math.round((parseFloat(leasePrice.replace(',', '.')) || 0) * 100);
  const anyType = sellOn || leaseOn || freeOn;
  const pricesOk = (!sellOn || sellPriceCents > 0) && (!leaseOn || leasePriceCents > 0);
  const canPublish =
    !!title.trim() && !busy && anyType && pricesOk
    && (hasExistingFile || !!file || category === 'service');

  // Earnings preview for the "main" paid deal (the buy-out when both are on).
  const earnPreviewCents = sellOn && sellPriceCents > 0 ? sellPriceCents : leaseOn ? leasePriceCents : 0;

  const typesInput = (): ListingTypesInput => ({
    sell: { enabled: sellOn, priceCents: sellPriceCents },
    lease: { enabled: leaseOn, priceCents: leasePriceCents },
    free: { enabled: freeOn, requiresFollow: freeFollow, likePostIds: freePostIds },
  });

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
        });
        await updateListingTypes(editId, typesInput());
      } else {
        const created = await createListing({
          title, description, category, genre,
          types: typesInput(),
        });
        listingId = created.id;
      }
      const media: Partial<{ cover_url: string; preview_url: string; file_path: string }> = {};
      if (coverUri) media.cover_url = await uploadListingCover(listingId, coverUri);
      if (preview) media.preview_url = await uploadListingPreview(listingId, preview.uri, preview.mime);
      if (file) media.file_path = await uploadListingFile(listingId, file.uri, file.mime, file.name);
      if (Object.keys(media).length) await updateListing(listingId, media);
      tabTick(); // published — mark the moment
      router.back();
    } catch {
      setError(t('shop.error'));
    }
    setBusy(false);
  }

  const coverShown = coverUri ?? existingCover;

  // One highlightable card per deal type: chip row + its own price /
  // conditions when enabled.
  function typeCard(
    kind: 'sell' | 'lease' | 'free',
    on: boolean,
    setOn: (v: boolean) => void,
    body?: React.ReactNode,
  ) {
    const label = t(`shop.license.${kind === 'sell' ? 'exclusive' : kind === 'lease' ? 'nonexclusive' : 'free'}`);
    const icon = kind === 'sell' ? 'flash-outline' : kind === 'lease' ? 'repeat-outline' : 'gift-outline';
    return (
      <View style={[styles.typeCard, on && styles.typeCardOn]}>
        <TouchableOpacity style={styles.typeHead} onPress={() => setOn(!on)} activeOpacity={0.75}>
          <Ionicons name={icon as never} size={18} color={on ? colors.success : colors.textTertiary} />
          <Text style={[styles.typeLabel, on && styles.typeLabelOn]}>{label}</Text>
          <Ionicons
            name={on ? 'checkmark-circle' : 'ellipse-outline'}
            size={22}
            color={on ? colors.success : colors.textTertiary}
          />
        </TouchableOpacity>
        {on && (
          <>
            <Text style={styles.typeInfo}>
              {t(`shop.licenseInfo.${kind === 'sell' ? 'exclusive' : kind === 'lease' ? 'nonexclusive' : 'free'}`)}
            </Text>
            {body}
          </>
        )}
      </View>
    );
  }

  function priceInput(value: string, setValue: (v: string) => void) {
    return (
      <View style={styles.priceRow}>
        <Text style={styles.priceSymbol}>$</Text>
        <TextInput
          style={[styles.input, styles.priceInput]}
          placeholder="0.00"
          placeholderTextColor={colors.textTertiary}
          value={value}
          onChangeText={setValue}
          keyboardType="decimal-pad"
          maxLength={9}
        />
      </View>
    );
  }

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

          {/* Deal types — highlight every way this can be bought. */}
          <Text style={styles.label}>{t('shop.typesLabel')}</Text>
          <Text style={styles.typesSub}>{t('shop.typesSub')}</Text>

          {typeCard('lease', leaseOn, setLeaseOn, priceInput(leasePrice, setLeasePrice))}
          {typeCard('sell', sellOn, setSellOn, priceInput(sellPrice, setSellPrice))}
          {typeCard('free', freeOn, setFreeOn, (
            <View style={styles.condWrap}>
              <Text style={styles.condLabel}>{t('shop.freeCondLabel')}</Text>
              <View style={styles.condRow}>
                <Ionicons name="person-add-outline" size={17} color={colors.textSecondary} />
                <Text style={styles.condText}>{t('shop.freeCondFollow')}</Text>
                <Switch
                  value={freeFollow}
                  onValueChange={setFreeFollow}
                  trackColor={{ true: colors.success, false: colors.surfaceLight }}
                  thumbColor="#fff"
                />
              </View>
              <TouchableOpacity style={styles.condRow} onPress={openPostPicker} activeOpacity={0.75}>
                <Ionicons name="heart-outline" size={17} color={colors.textSecondary} />
                <Text style={styles.condText}>
                  {freePostIds.length
                    ? t('shop.freeCondLikes', { n: freePostIds.length })
                    : t('shop.pickPosts')}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
              </TouchableOpacity>
            </View>
          ))}

          {/* Poshmark-style earnings breakdown — live as prices are typed. */}
          {earnPreviewCents > 0 && (
            <View style={styles.earnCard}>
              <View style={styles.earnRow}>
                <Text style={styles.earnLabel}>{t('shop.earnPrice')}</Text>
                <Text style={styles.earnValue}>{formatPrice(earnPreviewCents)}</Text>
              </View>
              <View style={styles.earnRow}>
                <Text style={styles.earnLabel}>{t('shop.earnFee')}</Text>
                <Text style={styles.earnValue}>−{formatPrice(shopFeeCents(earnPreviewCents))}</Text>
              </View>
              <View style={styles.earnRow}>
                <Text style={styles.earnLabel}>{t('shop.earnTax')}</Text>
                <Text style={styles.earnValueMuted}>+{formatPrice(buyerTaxCents(earnPreviewCents))}</Text>
              </View>
              <View style={styles.earnDivider} />
              <View style={styles.earnRow}>
                <Text style={styles.earnTotalLabel}>{t('shop.earnYou')}</Text>
                <Text style={styles.earnTotalValue}>{formatPrice(sellerEarningsCents(earnPreviewCents))}</Text>
              </View>
              <Text style={styles.earnNote}>{t('shop.earnNote')}</Text>
            </View>
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

        {/* Which posts must be liked to claim the freebie. */}
        <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => setPickerOpen(false)}>
          <View style={[styles.pickerRoot, { paddingTop: insets.top + 8 }]}>
            <View style={styles.header}>
              <TouchableOpacity onPress={() => setPickerOpen(false)} style={styles.headerBtn}>
                <Ionicons name="chevron-back" size={24} color={colors.text} />
              </TouchableOpacity>
              <Text style={styles.headerTitle}>{t('shop.pickPostsTitle')}</Text>
              <TouchableOpacity onPress={() => setPickerOpen(false)} style={styles.headerBtn}>
                <Text style={styles.pickerDone}>{t('shop.pickPostsDone')}</Text>
              </TouchableOpacity>
            </View>
            {myPosts === null ? (
              <ActivityIndicator color={colors.success} style={{ marginTop: 40 }} />
            ) : (
              <FlatList
                data={myPosts}
                keyExtractor={(p) => p.id}
                numColumns={3}
                contentContainerStyle={styles.pickerGrid}
                columnWrapperStyle={{ gap: 3 }}
                ListEmptyComponent={<Text style={styles.pickerEmpty}>{t('shop.pickPostsEmpty')}</Text>}
                renderItem={({ item }) => {
                  const on = freePostIds.includes(item.id);
                  return (
                    <TouchableOpacity
                      style={styles.pickerCell}
                      onPress={() => setFreePostIds((prev) =>
                        on ? prev.filter((p) => p !== item.id) : [...prev, item.id])}
                      activeOpacity={0.8}
                    >
                      {item.thumb ? (
                        <Image source={{ uri: item.thumb }} style={styles.pickerThumb} />
                      ) : (
                        <View style={[styles.pickerThumb, styles.pickerThumbEmpty]}>
                          <Ionicons name="musical-note" size={20} color={colors.textTertiary} />
                        </View>
                      )}
                      {on && (
                        <View style={styles.pickerSel}>
                          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </View>
        </Modal>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  headerBtn: { minWidth: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
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
  typesSub: { color: c.textTertiary, fontSize: 12, lineHeight: 17, marginTop: -4 },
  // One card per deal type; enabling it reveals its price / conditions.
  typeCard: {
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: c.border, padding: 12, gap: 10,
  },
  typeCardOn: { borderColor: c.success },
  typeHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  typeLabel: { flex: 1, color: c.textSecondary, fontSize: 14, fontWeight: '700' },
  typeLabelOn: { color: c.text },
  typeInfo: { color: c.textTertiary, fontSize: 12, lineHeight: 17 },
  condWrap: { gap: 10 },
  condLabel: { color: c.textSecondary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  condRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  condText: { flex: 1, color: c.text, fontSize: 13, fontWeight: '600' },
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
  // Post picker (free-claim like conditions)
  pickerRoot: { flex: 1, backgroundColor: c.background },
  pickerDone: { color: c.success, fontSize: 14, fontWeight: '700', paddingHorizontal: 8 },
  pickerGrid: { padding: 3, gap: 3 },
  pickerCell: { flex: 1 / 3, aspectRatio: 1, padding: 1.5 },
  pickerThumb: { width: '100%', height: '100%', borderRadius: 4, backgroundColor: c.surfaceLight },
  pickerThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  pickerSel: {
    position: 'absolute', top: 6, right: 6,
    backgroundColor: c.background, borderRadius: 11,
  },
  pickerEmpty: { color: c.textTertiary, fontSize: 13, textAlign: 'center', marginTop: 40 },
});
