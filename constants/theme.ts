// Brand + semantic colors stay constant across every display mode; only the
// neutral surfaces/text shift per theme.
const BRAND = {
  primary: '#F26522',
  primaryLight: '#FAB525',
  primaryDark: '#E8401C',
  gold: '#F59E0B',
  silver: '#94A3B8',
  bronze: '#CD7F32',
  diamond: '#A5F3FC',
  error: '#F43F5E',
  like: '#F43F5E',
  success: '#22C55E',
};

// ─── Display modes ─────────────────────────────────────────────────────────────
// Dark (pure black, default), Grey (softer graphite), Light (white). Every key
// matches across palettes so any screen can swap between them by reading the
// active theme (see ThemeContext + useTheme).
const DARK = {
  background: '#090909',
  surface: '#111111',
  surfaceLight: '#181818',
  surfaceElevated: '#1E1E1E',
  border: '#242424',
  borderSubtle: '#1A1A1A',
  text: '#F5F5F5',
  textSecondary: '#A0A0A0',
  textMeta: '#7C7C7C',
  textTertiary: '#484848',
  ...BRAND,
};

const GREY = {
  background: '#2B2B2F',
  surface: '#343439',
  surfaceLight: '#3B3B41',
  surfaceElevated: '#45454B',
  border: '#54545C',
  borderSubtle: '#3B3B41',
  text: '#F6F6F7',
  textSecondary: '#C2C2CA',
  textMeta: '#9A9AA2',
  textTertiary: '#74747C',
  ...BRAND,
};

const LIGHT = {
  background: '#F2F2F6',
  surface: '#EAEAEF',
  surfaceLight: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  border: '#DCDCE2',
  borderSubtle: '#E8E8EE',
  text: '#16161A',
  textSecondary: '#5E5E66',
  textMeta: '#8A8A92',
  textTertiary: '#B4B4BC',
  ...BRAND,
};

export type ThemeMode = 'dark' | 'grey' | 'light';
export type ThemePalette = typeof DARK;
export const THEMES: Record<ThemeMode, ThemePalette> = { dark: DARK, grey: GREY, light: LIGHT };

// Default/static palette. Screens not yet converted to the live theme import this
// directly and stay on Dark; converted screens read the active palette via useTheme.
export const COLORS = DARK;

export const GRADIENTS = {
  primary: ['#E8401C', '#F26522'] as const,
  primaryWarm: ['#F26522', '#FAB525'] as const,
  primarySoft: ['#F2652218', '#E8401C0A'] as const,
  logo: ['#E8401C', '#F26522', '#FAB525'] as const,
  card: ['#1A1A1A', '#111111'] as const,
  gold: ['#F59E0B', '#D97706'] as const,
  diamond: ['#A5F3FC', '#67E8F9'] as const,
};

export const SHADOWS = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 5,
  },
  glow: {
    shadowColor: '#F26522',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 6,
  },
};

export const FONTS = {
  regular: 'System',
  medium: 'System',
  bold: 'System',
};

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const RADIUS = {
  xs: 4,
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  full: 9999,
};
