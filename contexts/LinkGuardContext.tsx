import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Linking, ActivityIndicator, Platform } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from './ThemeContext';
import { useTranslation } from './LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import {
  analyzeUrl, checkUrlReputation, worstVerdict, loadBlocklist, reportLink, auditLinkDecision,
  type LinkAnalysis, type LinkReasonCode, type LinkVerdict,
} from '../lib/linkSafety';

// Global "you're leaving Laybell" guard. EVERY external link — profile links,
// message links, ad CTAs — is opened through useLinkGuard().open() instead of a
// bare Linking.openURL, so the user always sees the real destination first, risky
// links are flagged, and dangerous ones are hard-blocked. This is the single
// biggest reduction in third-party-link liability: nothing opens silently.

type OpenOpts = {
  context?: 'bio' | 'message' | 'ad' | 'other';
  // The advertiser/owner name, shown for ad CTAs.
  sourceName?: string;
  // Called only if the user actually proceeds (e.g. record an ad click on open).
  onProceed?: () => void;
};

type LinkGuardValue = { open: (rawUrl: string, opts?: OpenOpts) => void };

const LinkGuardContext = createContext<LinkGuardValue>({ open: () => {} });

export function useLinkGuard() {
  return useContext(LinkGuardContext);
}

// Short, friendly explanations for the riskiest signals (shown under the warn /
// block banner). Kept compact — the banner already states the headline.
const REASON_TEXT: Partial<Record<LinkReasonCode, string>> = {
  embedded_credentials: 'The address hides its true destination behind an “@”.',
  blocklisted: 'This site is on Laybell’s block list.',
  adult_keyword: 'The address contains explicit or adult-content terms.',
  sensitive_keyword: 'The address contains words that may point to sensitive content.',
  shortener: 'A link shortener is hiding where this really goes.',
  suspicious_tld: 'Uses a domain type often used for scams or malware.',
  ip_host: 'Points to a raw IP address instead of a named website.',
  punycode: 'The address uses look-alike (non-Latin) characters.',
  non_https: 'Not a secure (https) connection.',
  dangerous_scheme: 'Uses an unsafe link type.',
  unknown_scheme: 'Tries to open another app in an unexpected way.',
  too_long: 'Unusually long or obfuscated address.',
  many_subdomains: 'Unusually deeply-nested address.',
};

export function LinkGuardProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);

  const [visible, setVisible] = useState(false);
  const [analysis, setAnalysis] = useState<LinkAnalysis | null>(null);
  const [checking, setChecking] = useState(false);
  const [reported, setReported] = useState(false);
  const optsRef = useRef<OpenOpts>({});
  const reqRef = useRef(0); // guards against a stale async reputation result

  // Pull the server blocklist once at startup (no-ops if not migrated).
  useEffect(() => { loadBlocklist(); }, []);

  const open = useCallback((rawUrl: string, opts: OpenOpts = {}) => {
    const a = analyzeUrl(rawUrl);
    optsRef.current = opts;
    setReported(false);
    setAnalysis(a);
    setVisible(true);
    // Record a stopped link immediately — this is the evidence the system
    // actively blocks dangerous destinations, not just that one was dismissed.
    if (a.verdict === 'block') auditLinkDecision(a, 'blocked', opts.context ?? 'other');
    // Layer the optional server reputation check on top of the offline verdict.
    const req = ++reqRef.current;
    if (a.verdict !== 'block') {
      setChecking(true);
      checkUrlReputation(a.normalized ?? rawUrl).then((rep) => {
        if (req !== reqRef.current) return; // a newer open() superseded this
        setChecking(false);
        if (!rep) return;
        setAnalysis((prev) => {
          if (!prev) return prev;
          const merged = worstVerdict(prev.verdict, rep);
          // Reputation just escalated a link to 'block' — log that stop too.
          if (merged === 'block' && prev.verdict !== 'block') {
            auditLinkDecision({ ...prev, verdict: merged }, 'blocked', optsRef.current.context ?? 'other');
          }
          return { ...prev, verdict: merged };
        });
      });
    } else {
      setChecking(false);
    }
  }, []);

  function close() {
    setVisible(false);
    // 'blocked' links are already logged on open; only log a user-declined choice.
    if (analysis && analysis.verdict !== 'block') auditLinkDecision(analysis, 'cancelled', optsRef.current.context ?? 'other');
  }

  function proceed() {
    const a = analysis;
    if (!a || a.verdict === 'block' || !a.normalized) return;
    setVisible(false);
    auditLinkDecision(a, 'opened', optsRef.current.context ?? 'other');
    optsRef.current.onProceed?.();
    Linking.openURL(a.normalized).catch(() => {});
  }

  async function onReport() {
    const a = analysis;
    if (!a) return;
    setReported(true);
    await reportLink(a.raw, optsRef.current.context ?? 'other');
  }

  const blocked = analysis?.verdict === 'block';
  const warn = analysis?.verdict === 'warn';
  const topReason = analysis?.reasons.find((r) => REASON_TEXT[r]);

  const content = (
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <View style={[styles.iconWrap, blocked ? styles.iconBlocked : warn ? styles.iconWarn : styles.iconNeutral]}>
              <Ionicons
                name={blocked ? 'shield' : warn ? 'warning' : 'open-outline'}
                size={26}
                color={blocked ? colors.error : warn ? '#E8A93B' : colors.primary}
              />
            </View>

            <Text style={styles.title}>
              {blocked ? t('linkGuard.blockedTitle') : t('linkGuard.leavingTitle')}
            </Text>

            {/* The real destination, prominently. */}
            <Text style={styles.destLabel}>{t('linkGuard.destination')}</Text>
            <View style={styles.urlBox}>
              <Text style={styles.host} numberOfLines={1}>{analysis?.host ?? analysis?.raw}</Text>
              {!!analysis?.normalized && analysis.normalized !== analysis.host && (
                <Text style={styles.fullUrl} numberOfLines={2}>{analysis?.normalized ?? analysis?.raw}</Text>
              )}
            </View>

            {!!optsRef.current.sourceName && (
              <Text style={styles.sourceName}>{t('linkGuard.fromAd', { name: optsRef.current.sourceName })}</Text>
            )}

            {/* Risk banner. */}
            {blocked ? (
              <View style={[styles.banner, styles.bannerBlocked]}>
                <Text style={styles.bannerText}>{t('linkGuard.blockedBanner')}</Text>
                {!!topReason && <Text style={styles.reasonText}>{REASON_TEXT[topReason]}</Text>}
              </View>
            ) : warn ? (
              <View style={[styles.banner, styles.bannerWarn]}>
                <Text style={styles.bannerText}>{t('linkGuard.warnBanner')}</Text>
                {!!topReason && <Text style={styles.reasonText}>{REASON_TEXT[topReason]}</Text>}
              </View>
            ) : null}

            {checking && (
              <View style={styles.checkingRow}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
                <Text style={styles.checkingText}>{t('linkGuard.checking')}</Text>
              </View>
            )}

            <Text style={styles.disclaimer}>{t('linkGuard.disclaimer')}</Text>

            {/* Actions */}
            {!blocked && (
              <TouchableOpacity style={styles.primaryBtn} onPress={proceed} activeOpacity={0.85} disabled={checking}>
                <Text style={styles.primaryBtnText}>{t('linkGuard.continue')}</Text>
                <Ionicons name="arrow-forward" size={16} color="#fff" />
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.secondaryBtn} onPress={close} activeOpacity={0.7}>
              <Text style={styles.secondaryBtnText}>{blocked ? t('linkGuard.gotIt') : t('linkGuard.cancel')}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.reportRow} onPress={onReport} disabled={reported} hitSlop={8}>
              <Ionicons name={reported ? 'checkmark-circle' : 'flag-outline'} size={14} color={colors.textTertiary} />
              <Text style={styles.reportText}>{reported ? t('linkGuard.reported') : t('linkGuard.report')}</Text>
            </TouchableOpacity>
          </View>
        </View>
  );

  // iOS: a <Modal> hosted inside a FullWindowOverlay deadlocks (see
  // PostOptionsContext), and the player chrome already lives in a
  // FullWindowOverlay — so the interstitial must live in its OWN overlay and
  // present as a plain absolute-fill view to sit above everything, including an
  // ad CTA tapped from the expanded Now Playing. Android uses a normal Modal.
  const layer = Platform.OS === 'ios'
    ? (visible ? <View style={StyleSheet.absoluteFill}>{content}</View> : null)
    : (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
        {content}
      </Modal>
    );

  return (
    <LinkGuardContext.Provider value={{ open }}>
      {children}
      {Platform.OS === 'ios' ? <FullWindowOverlay>{layer}</FullWindowOverlay> : layer}
    </LinkGuardContext.Provider>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center', padding: SPACING.lg,
  },
  card: {
    width: '100%', maxWidth: 380,
    backgroundColor: c.surfaceElevated,
    borderRadius: RADIUS.xl, borderWidth: 1, borderColor: c.border,
    padding: SPACING.lg, alignItems: 'center', gap: SPACING.sm,
  },
  iconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.xs },
  iconNeutral: { backgroundColor: c.primary + '1A' },
  iconWarn: { backgroundColor: '#E8A93B22' },
  iconBlocked: { backgroundColor: c.error + '22' },
  title: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },

  destLabel: { color: c.textTertiary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: SPACING.xs, alignSelf: 'flex-start' },
  urlBox: {
    alignSelf: 'stretch', backgroundColor: c.surfaceLight,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: c.border,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: 2,
  },
  host: { color: c.text, fontSize: 15, fontWeight: '700' },
  fullUrl: { color: c.textSecondary, fontSize: 12 },
  sourceName: { color: c.textTertiary, fontSize: 12, alignSelf: 'flex-start' },

  banner: { alignSelf: 'stretch', borderRadius: RADIUS.md, padding: SPACING.sm + 2, gap: 2 },
  bannerWarn: { backgroundColor: '#E8A93B1A', borderWidth: 1, borderColor: '#E8A93B55' },
  bannerBlocked: { backgroundColor: c.error + '14', borderWidth: 1, borderColor: c.error + '55' },
  bannerText: { color: c.text, fontSize: 13, fontWeight: '700' },
  reasonText: { color: c.textSecondary, fontSize: 12, lineHeight: 17 },

  checkingRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  checkingText: { color: c.textSecondary, fontSize: 12 },

  disclaimer: { color: c.textTertiary, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: SPACING.xs },

  primaryBtn: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: c.primary, borderRadius: RADIUS.full, paddingVertical: SPACING.md, marginTop: SPACING.xs,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  secondaryBtn: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: SPACING.sm + 2 },
  secondaryBtnText: { color: c.textSecondary, fontSize: 14, fontWeight: '700' },

  reportRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: SPACING.xs },
  reportText: { color: c.textTertiary, fontSize: 12, fontWeight: '600' },
});
