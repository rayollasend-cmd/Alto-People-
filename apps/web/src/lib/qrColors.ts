/**
 * The colours baked into a QR code image (the two-step sign-in enrolment
 * code on Sign in and Settings). A phone's camera needs dark modules on a
 * light quiet zone whatever the theme, and the encoder paints a canvas that
 * cannot read a CSS variable — so these are fixed, not theme tokens.
 */
export const QR_COLORS = { dark: '#0f172a', light: '#ffffff' } as const;
