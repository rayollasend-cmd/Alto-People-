import { inflateSync } from 'node:zlib';

/**
 * The text drawn on a pdfkit PDF, for assertions in tests.
 *
 * Documents built on docKit embed their own fonts (Geist, Cormorant), so
 * the text in a content stream is glyph numbers, not characters. Each
 * embedded font carries a ToUnicode map; this reads those maps and decodes
 * every Tj/TJ string with the font that was active when it was drawn. Text
 * in the built-in fonts (no map) decodes as Latin-1, as before.
 *
 * Text runs are joined with a space within a line and a newline between
 * lines, so `toContain('Net pay')` works across separately drawn runs only
 * when they were drawn as one string.
 */
export function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const objects = new Map<number, { dict: string; stream: Buffer | null }>();
  const objRe = /(\d+) 0 obj\s*([\s\S]*?)endobj/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(raw))) {
    const id = Number(m[1]);
    const body = m[2]!;
    const si = body.indexOf('stream');
    if (si >= 0 && /\/Length/.test(body.slice(0, si))) {
      const start = si + 'stream'.length + (body[si + 6] === '\r' ? 2 : 1);
      const end = body.lastIndexOf('endstream');
      let stream = Buffer.from(body.slice(start, end), 'latin1');
      if (/\/FlateDecode/.test(body.slice(0, si))) {
        try {
          stream = inflateSync(stream);
        } catch {
          // leave as is
        }
      }
      objects.set(id, { dict: body.slice(0, si), stream });
    } else {
      objects.set(id, { dict: body, stream: null });
    }
  }

  // ToUnicode maps, by font object id.
  const cmapOf = (id: number): Map<string, string> => {
    const o = objects.get(id);
    const map = new Map<string, string>();
    if (!o?.stream) return map;
    const s = o.stream.toString('latin1');
    for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(p[1]!.toLowerCase(), hexToUtf16(p[2]!.replace(/\s+/g, '')));
    }
    for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g)) {
        const lo = parseInt(p[1]!, 16);
        const hi = parseInt(p[2]!, 16);
        const w = p[1]!.length;
        if (p[3]!.startsWith('[')) {
          const list = [...p[3]!.matchAll(/<([0-9a-fA-F\s]+)>/g)].map((x) => hexToUtf16(x[1]!.replace(/\s+/g, '')));
          for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(w, '0'), list[c - lo] ?? '');
        } else {
          const base = parseInt(p[3]!.slice(1, -1), 16);
          for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(w, '0'), String.fromCodePoint(base + (c - lo)));
        }
      }
    }
    return map;
  };

  // Font resource names → their ToUnicode map (pdfkit names fonts uniquely per document).
  const fonts = new Map<string, Map<string, string> | null>();
  for (const o of objects.values()) {
    for (const r of o.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const f of r[1]!.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
        if (fonts.has(f[1]!)) continue;
        const fontObj = objects.get(Number(f[2]));
        const tu = fontObj?.dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
        fonts.set(f[1]!, tu ? cmapOf(Number(tu[1])) : null);
      }
    }
  }

  const decode = (hex: string, cmap: Map<string, string> | null): string => {
    if (!cmap) return Buffer.from(hex, 'hex').toString('latin1');
    let out = '';
    const step = [...cmap.keys()][0]?.length ?? 4;
    for (let i = 0; i < hex.length; i += step) out += cmap.get(hex.slice(i, i + step).toLowerCase()) ?? '';
    return out;
  };

  const lines: string[] = [];
  for (const o of objects.values()) {
    if (!o.stream || /\/Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType)|\/Length1/.test(o.dict)) continue;
    const s = o.stream.toString('latin1');
    if (!/T[Jj]/.test(s)) continue;
    let font: Map<string, string> | null = null;
    const tokenRe = /\/(F\d+)\s+[\d.]+\s+Tf|\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj|\bET\b/g;
    let line: string[] = [];
    let t: RegExpExecArray | null;
    while ((t = tokenRe.exec(s))) {
      if (t[1]) font = fonts.get(t[1]) ?? null;
      else if (t[2] !== undefined) line.push([...t[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => decode(h[1]!, font)).join(''));
      else if (t[3] !== undefined) line.push(decode(t[3], font));
      else if (line.length) {
        lines.push(line.join(''));
        line = [];
      }
    }
    if (line.length) lines.push(line.join(''));
  }
  return lines.join('\n');
}

function hexToUtf16(hex: string): string {
  const codes: number[] = [];
  for (let i = 0; i < hex.length; i += 4) codes.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...codes);
}

/** The same text with nothing between runs: for names drawn in more than one font subset ("Şükrü"). */
export function pdfTextJoined(pdf: Buffer): string {
  return pdfText(pdf).replace(/\n/g, '');
}
