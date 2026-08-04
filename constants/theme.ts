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
  // Default-avatar placeholder (the circle shown when a user has no photo).
  // Deliberately NOT the brand orange: a screen full of orange initials reads as
  // "everyone is highlighted", and the orange competes with real CTAs. A calm
  // blue-grey recedes so real avatars and buttons are what draw the eye. Kept
  // constant across all three display modes so an account looks the same
  // everywhere; `avatarFg` is the initial on top of it.
  avatarBg: '#5B6B7F',
  avatarFg: '#FFFFFF',
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
  borderStrong: '#3B3B3B',
  borderSubtle: '#1A1A1A',
  text: '#F5F5F5',
  textSecondary: '#A0A0A0',
  textMeta: '#7C7C7C',
  textTertiary: '#484848',
  ...BRAND,
};

// A near-black graphite (but not the pure black of Dark), now with a faint WARM
// bias instead of a cold pure-neutral so the surfaces read matte rather than
// glossy. Same darkness as before — crisp whites + lighter borders keep surfaces
// and text separating sharply. Still sits clearly above Dark's #090909.
const GREY = {
  background: '#161514',
  surface: '#1F1E1C',
  surfaceLight: '#292826',
  surfaceElevated: '#322F2D',
  border: '#413F3B',
  borderStrong: '#5C5952',
  borderSubtle: '#2C2A28',
  text: '#FFFFFF',
  textSecondary: '#CECECE',
  textMeta: '#999999',
  textTertiary: '#6A6A6A',
  ...BRAND,
};

// Matte off-white. The old palette was cool-blue-tinted with PURE-white cards,
// which read shiny/clinical; this drops the blue for a faint warm-neutral cast
// and softens the brightest surfaces to an off-white (no pure #FFFFFF) so it
// looks like flat paper rather than a glossy screen.
const LIGHT = {
  background: '#F2F1ED',
  surface: '#EAE8E3',
  surfaceLight: '#F9F8F4',
  surfaceElevated: '#FCFBF7',
  // Crisp, clean hairlines: defined enough to read clearly against the off-white
  // surfaces without going heavy. `border` is the standard visible edge; the
  // subtle one is for quiet dividers.
  border: '#D4D1C9',
  borderStrong: '#B8B4A8',
  borderSubtle: '#E2DFD7',
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
  // Default-avatar fill. Same blue-grey as COLORS.avatarBg, with the same subtle
  // top-left→bottom-right depth the brand gradient gave it, so swapping this in
  // changes only the hue — never the shape, size, or weight of any avatar.
  avatar: ['#6B7C91', '#4E5D6E'] as const,
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
