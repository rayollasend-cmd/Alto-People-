// Hugo v2 — a character with hands, headphones that say whether he's working, and a pose for each state.
// viewBox 0 0 240 240; body centred on x=120.
const C = { navyTop: '#2C4F8C', navyBot: '#0E2244', arm: '#1B3A6E', mitt: '#EEF4FB', mittShade: '#C9D7E8', gold1: '#F3DC85', gold2: '#B8862E', silver: '#C0D0E0', teal: '#2DD4BF', coral: '#F28B82', ink: '#0B1832', sky: '#E6F1FB', greyTop: '#6B7A90', greyBot: '#2E3746' };
const defs = (offline) => `<defs>
  <linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${offline ? C.greyTop : C.navyTop}"/><stop offset="1" stop-color="${offline ? C.greyBot : C.navyBot}"/></linearGradient>
  <linearGradient id="gold" gradientUnits="userSpaceOnUse" x1="40" y1="40" x2="200" y2="200"><stop offset="0" stop-color="${offline ? '#C9BC92' : C.gold1}"/><stop offset="1" stop-color="${offline ? '#7D7356' : C.gold2}"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="${C.teal}" stop-opacity="0.55"/><stop offset="1" stop-color="${C.teal}" stop-opacity="0"/></radialGradient>
  <radialGradient id="screen" cx="0.5" cy="0.2" r="0.9"><stop offset="0" stop-color="${C.teal}" stop-opacity="0.35"/><stop offset="1" stop-color="${C.teal}" stop-opacity="0"/></radialGradient>
  <linearGradient id="lid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#DCE6F2"/><stop offset="1" stop-color="#A9B9CC"/></linearGradient>
</defs>`;
const wrap = (inner, offline = false) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">${defs(offline)}${inner}</svg>`;

const shadow = `<ellipse cx="120" cy="214" rx="58" ry="7" fill="#000" opacity="0.22"/>`;
const body = `<path d="M120 66 C167 66 188 96 188 136 C188 180 160 204 120 204 C80 204 52 180 52 136 C52 96 73 66 120 66 Z" fill="url(#body)"/>
  <path d="M74 104 C80 86 98 76 116 74" fill="none" stroke="#fff" stroke-opacity="0.16" stroke-width="5" stroke-linecap="round"/>`;
const tuft = `<path d="M120 30 L125.5 56 L136 61 L125.5 66 L120 78 L114.5 66 L104 61 L114.5 56 Z" fill="url(#gold)"/>`;
const cheeks = `<ellipse cx="86" cy="146" rx="9" ry="5" fill="${C.coral}" opacity="0.5"/><ellipse cx="154" cy="146" rx="9" ry="5" fill="${C.coral}" opacity="0.5"/>`;

const eyes = (look = [2, 2], shape = 'open') => {
  if (shape === 'happy') return [98, 142].map((x) => `<path d="M${x - 12} 124 C${x - 8} 112 ${x + 8} 112 ${x + 12} 124" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`).join('');
  if (shape === 'closed') return [98, 142].map((x) => `<path d="M${x - 12} 122 C${x - 7} 129 ${x + 7} 129 ${x + 12} 122" fill="none" stroke="#fff" stroke-opacity="0.85" stroke-width="5" stroke-linecap="round"/>`).join('');
  const ry = shape === 'focus' ? 12 : 16;
  return [98, 142].map((x) => `<ellipse cx="${x}" cy="120" rx="13" ry="${ry}" fill="#fff"/><ellipse cx="${x + look[0]}" cy="${120 + look[1]}" rx="7.5" ry="${Math.min(9, ry - 3)}" fill="${C.ink}"/><circle cx="${x + look[0] + 3}" cy="${120 + look[1] - 4}" r="2.6" fill="#fff"/>`).join('');
};
const mouth = (kind) => ({
  smile: `<path d="M109 144 C114 153 126 153 131 144" fill="none" stroke="${C.sky}" stroke-width="4.5" stroke-linecap="round"/>`,
  open: `<path d="M106 142 C112 160 128 160 134 142 Z" fill="${C.ink}" stroke="${C.sky}" stroke-width="3.5" stroke-linejoin="round"/><path d="M113 151 C117 155 123 155 127 151" fill="none" stroke="${C.coral}" stroke-width="3" stroke-linecap="round"/>`,
  hmm: `<path d="M114 149 C119 149 123 146 129 145" fill="none" stroke="${C.sky}" stroke-width="4" stroke-linecap="round"/>`,
  o: `<ellipse cx="120" cy="149" rx="4.5" ry="5.5" fill="none" stroke="${C.sky}" stroke-width="3.5"/>`,
  talk: `<path d="M110 144 C114 154 126 154 130 144 Z" fill="${C.ink}" stroke="${C.sky}" stroke-width="3.5" stroke-linejoin="round"/>`,
})[kind];

// Headphones ON the head (working, listening) — padded over-ear cups, a band, and a mic boom.
const phonesOn = (micLit) => `
  <path d="M50 134 C50 38 190 38 190 134" fill="none" stroke="${C.silver}" stroke-width="8" stroke-linecap="round"/>
  <rect x="34" y="112" width="28" height="46" rx="14" fill="url(#gold)"/><rect x="41" y="119" width="14" height="32" rx="7" fill="#000" opacity="0.12"/>
  <rect x="178" y="112" width="28" height="46" rx="14" fill="url(#gold)"/><rect x="185" y="119" width="14" height="32" rx="7" fill="#000" opacity="0.12"/>
  <path d="M48 156 C50 172 66 178 84 172" fill="none" stroke="${C.silver}" stroke-width="5" stroke-linecap="round"/>
  ${micLit ? `<circle cx="89" cy="170" r="16" fill="url(#glow)"/>` : ''}<circle cx="89" cy="170" r="7" fill="${micLit ? C.teal : C.silver}"/>`;
// Headphones AROUND THE NECK (not working) — band in front, cups resting low.
const phonesNeck = (offline = false) => `
  <path d="M78 186 C78 160 162 160 162 186" fill="none" stroke="${offline ? '#8C99AB' : C.silver}" stroke-width="6.5" stroke-linecap="round"/>
  <rect x="64" y="170" width="26" height="36" rx="13" fill="url(#gold)" transform="rotate(-14 77 188)"/>
  <rect x="150" y="170" width="26" height="36" rx="13" fill="url(#gold)" transform="rotate(14 163 188)"/>`;

const arm = (d) => `<path d="${d}" fill="none" stroke="${C.arm}" stroke-width="15" stroke-linecap="round"/>`;
const mitt = (x, y, r = 12) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.mitt}"/><path d="M${x - r * 0.55} ${y + r * 0.55} A${r} ${r} 0 0 0 ${x + r * 0.75} ${y + r * 0.35}" fill="none" stroke="${C.mittShade}" stroke-width="2.5" stroke-linecap="round"/>`;
const sparkle = (x, y, s = 1, color = C.gold1) => `<path d="M${x} ${y - 9 * s} l${2.4 * s} ${6.6 * s} l${6.6 * s} ${2.4 * s} l${-6.6 * s} ${2.4 * s} l${-2.4 * s} ${6.6 * s} l${-2.4 * s} ${-6.6 * s} l${-6.6 * s} ${-2.4 * s} l${6.6 * s} ${-2.4 * s} Z" fill="${color}"/>`;

export const POSES = {
  // Not working: headphones around his neck, waving hello.
  hello: { label: 'Say hi · not working', svg: () => wrap(`${shadow}
    ${arm('M58 158 C44 168 36 180 36 190')}${mitt(36, 195)}
    ${body}${tuft}${phonesNeck()}
    ${arm('M184 146 C204 138 214 114 212 90')}${mitt(212, 84, 13)}
    <path d="M226 70 C232 78 232 90 226 98" fill="none" stroke="${C.gold1}" stroke-width="3" stroke-linecap="round" opacity="0.8"/><path d="M234 62 C243 75 243 93 234 106" fill="none" stroke="${C.gold1}" stroke-width="3" stroke-linecap="round" opacity="0.5"/>
    ${eyes([2, 1])}${cheeks}${mouth('open')}`) },
  // Working: headphones on, typing on a laptop, the screen's glow on his face.
  working: { label: 'Working · typing', svg: () => wrap(`${shadow}
    ${body}${tuft}${phonesOn(true)}
    <ellipse cx="120" cy="150" rx="62" ry="40" fill="url(#screen)"/>
    ${eyes([0, 5], 'focus')}
    <rect x="72" y="140" width="96" height="58" rx="8" fill="url(#lid)"/>
    <path d="M120 156 L122.5 166 L127 168 L122.5 170 L120 180 L117.5 170 L113 168 L117.5 166 Z" fill="url(#gold)" opacity="0.9"/>
    <rect x="58" y="196" width="124" height="10" rx="5" fill="#8EA1B8"/>
    ${arm('M60 160 C58 178 70 190 84 196')}${mitt(86, 196, 11)}
    ${arm('M180 160 C182 178 170 190 156 196')}${mitt(154, 196, 11)}
    <path d="M82 178 v-6 M90 176 v-7 M150 176 v-7 M158 178 v-6" stroke="${C.teal}" stroke-width="2.5" stroke-linecap="round" opacity="0.9"/>`) },
  // Listening: headphones on, a hand to the ear cup, mic lit.
  listening: { label: 'Listening', svg: () => wrap(`${shadow}
    ${arm('M58 158 C44 168 36 180 36 190')}${mitt(36, 195)}
    ${body}${tuft}${phonesOn(true)}
    ${arm('M184 156 C204 152 210 142 204 130')}${mitt(200, 128, 12)}
    ${eyes([-4, 0])}${cheeks}${mouth('smile')}`) },
  // Thinking: hand on chin, eyes up, thought dots.
  thinking: { label: 'Thinking', svg: () => wrap(`${shadow}
    ${arm('M58 158 C44 168 36 180 36 190')}${mitt(36, 195)}
    ${body}${tuft}${phonesOn(false)}
    ${arm('M184 168 C176 186 158 180 146 166')}${mitt(142, 162, 11)}
    ${eyes([5, -6])}${cheeks}${mouth('hmm')}
    <circle cx="186" cy="64" r="5" fill="${C.gold1}"/><circle cx="200" cy="48" r="7" fill="${C.gold1}"/><circle cx="218" cy="30" r="9" fill="${C.gold1}"/>`) },
  // Handing off: passing a note to a person, with a little arc of motion.
  handoff: { label: 'Handing you to a person', svg: () => wrap(`${shadow}
    ${arm('M58 158 C44 168 36 180 36 190')}${mitt(36, 195)}
    ${body}${tuft}${phonesOn(false)}
    ${arm('M184 168 C198 174 210 174 218 168')}
    <g transform="rotate(-10 220 150)"><rect x="204" y="138" width="32" height="24" rx="4" fill="#fff"/><path d="M204 140 L220 152 L236 140" fill="none" stroke="${C.gold2}" stroke-width="2.5" stroke-linejoin="round"/></g>${mitt(220, 168, 11)}
    <path d="M196 118 C208 104 226 104 234 116" fill="none" stroke="${C.gold1}" stroke-width="3" stroke-linecap="round" stroke-dasharray="2 6" opacity="0.8"/>
    ${eyes([6, 0])}${cheeks}${mouth('smile')}`) },
  // Celebrating: both arms up, confetti.
  celebrate: { label: 'Celebrating', svg: () => wrap(`${shadow}
    ${arm('M60 146 C40 134 30 110 32 88')}${mitt(32, 82, 13)}
    ${arm('M180 146 C200 134 210 110 208 88')}${mitt(208, 82, 13)}
    ${body}${tuft}${phonesNeck()}
    ${eyes([0, 0], 'happy')}${cheeks}${mouth('open')}
    ${sparkle(60, 46, 1)}${sparkle(180, 40, 0.8, C.teal)}${sparkle(214, 140, 0.7, C.coral)}${sparkle(24, 140, 0.6, C.teal)}
    <rect x="148" y="24" width="6" height="12" rx="2" fill="${C.coral}" transform="rotate(25 151 30)"/><rect x="84" y="28" width="6" height="12" rx="2" fill="${C.teal}" transform="rotate(-30 87 34)"/>`) },
  // Offline: greyed, headphones around his neck, asleep.
  offline: { label: 'Offline · reconnecting', svg: () => wrap(`${shadow}
    ${arm('M58 156 C48 168 48 180 54 190')}${mitt(54, 194).replaceAll(C.mitt, '#C7CFDA')}
    ${arm('M182 156 C192 168 192 180 186 190')}${mitt(186, 194).replaceAll(C.mitt, '#C7CFDA')}
    ${body}${tuft}${phonesNeck(true)}
    ${eyes([0, 0], 'closed')}${mouth('o')}
    <path d="M168 54 h12 l-12 12 h12" fill="none" stroke="${C.silver}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M188 34 h9 l-9 9 h9" fill="none" stroke="${C.silver}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`, true).replaceAll(C.arm, '#3E4A5C') },
};
