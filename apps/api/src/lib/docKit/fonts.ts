import { createRequire } from 'node:module';
import * as fontkit from 'fontkit';

/**
 * The house typefaces, the same as the web app: Geist for everything a
 * person reads and Cormorant Garamond for display headings. Each weight
 * ships as per-script subsets (latin, latin-ext, vietnamese, cyrillic),
 * so a name like "Şükrü Yıldız" or "Nguyễn Thị Hằng" is drawn by
 * switching subset per run of characters (see runsFor) instead of
 * falling back to question marks.
 */

const require = createRequire(import.meta.url);

export type Family = 'sans' | 'display';
export type Weight = 'regular' | 'medium' | 'semibold' | 'bold';

const SUBSETS = ['latin', 'latin-ext', 'vietnamese', 'cyrillic', 'cyrillic-ext'] as const;
type Subset = (typeof SUBSETS)[number];

const FILE: Record<Family, { pkg: string; weights: Record<Weight, number> }> = {
  sans: { pkg: '@fontsource/geist/files/geist', weights: { regular: 400, medium: 500, semibold: 600, bold: 700 } },
  display: { pkg: '@fontsource/cormorant-garamond/files/cormorant-garamond', weights: { regular: 500, medium: 500, semibold: 600, bold: 600 } },
};

export function fontName(family: Family, weight: Weight, subset: Subset): string {
  return `${family}-${FILE[family].weights[weight]}-${subset}`;
}

function filePath(family: Family, weight: Weight, subset: Subset): string {
  return require.resolve(`${FILE[family].pkg}-${subset}-${FILE[family].weights[weight]}-normal.woff`);
}

// Glyph coverage per subset (the same for every weight of a family).
const coverage = new Map<string, fontkit.Font>();
function coverageFont(family: Family, subset: Subset): fontkit.Font {
  const key = `${family}-${subset}`;
  let f = coverage.get(key);
  if (!f) {
    f = fontkit.openSync(filePath(family, 'regular', subset)) as fontkit.Font;
    coverage.set(key, f);
  }
  return f;
}

/** Register every weight and subset of both families on a document. */
export function registerFonts(doc: PDFKit.PDFDocument): void {
  for (const family of Object.keys(FILE) as Family[]) {
    for (const weight of ['regular', 'medium', 'semibold', 'bold'] as Weight[]) {
      for (const subset of SUBSETS) doc.registerFont(fontName(family, weight, subset), filePath(family, weight, subset));
    }
  }
}

/**
 * Split a string into runs, each drawable by one subset. Characters no
 * subset carries become a plain transliteration (accents stripped) or,
 * failing that, a question mark.
 */
export function runsFor(text: string, family: Family): Array<{ subset: Subset; text: string }> {
  const out: Array<{ subset: Subset; text: string }> = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let subset: Subset | null = null;
    // Spaces and ASCII always draw in latin: keeps runs long.
    if (cp < 0x80) subset = 'latin';
    else for (const s of SUBSETS) if (coverageFont(family, s).hasGlyphForCodePoint(cp)) { subset = s; break; }
    let glyph = ch;
    // Symbols the subsets lack, swapped for the nearest glyph they carry.
    const SWAP: Record<string, string> = { '→': '›', '←': '‹', '⇒': '›', '➔': '›', '✓': '•', '✔': '•', '⚠': '!' };
    if (!subset && SWAP[ch]) {
      glyph = SWAP[ch];
      subset = 'latin';
    }
    if (!subset) {
      const bare = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      glyph = bare && coverageFont(family, 'latin').hasGlyphForCodePoint(bare.codePointAt(0)!) ? bare : '?';
      subset = 'latin';
    }
    const last = out[out.length - 1];
    if (last && last.subset === subset) last.text += glyph;
    else out.push({ subset, text: glyph });
  }
  return out;
}
