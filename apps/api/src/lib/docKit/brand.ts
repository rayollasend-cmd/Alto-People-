import { getBrandingSync } from '../branding.js';
import type { Brand } from './index.js';

/**
 * The signed-in tenant's name and logo for a masthead, from the branding
 * cache (lib/branding). A logo only when it is PNG or JPEG — the formats
 * the PDF library draws.
 */
export function currentBrand(lines: string[] = []): Brand {
  try {
    const b = getBrandingSync();
    const m = b.logoDataUri ? /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(b.logoDataUri) : null;
    return { name: b.orgName, logo: m ? Buffer.from(m[2]!, 'base64') : null, lines };
  } catch {
    return { name: 'Alto People', logo: null, lines };
  }
}
