// Declare the List template on pages shaped `<div className=…><PageHeader …/>…</div>`:
// the root div becomes <ListTemplate>, the header's props become the template's,
// everything else stays as children. `node list-codemod.mjs [--write] [files…]`
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const write = process.argv.includes('--write');
const args = process.argv.slice(2).filter((a) => a !== '--write');
const EXCLUDE = /src[\\/]pages[\\/](admin|settings|trust|relay|ops|hrCases|support|compliance|kiosk|portal|transport|messages|design|platform|approvals|home)[\\/]|Settings\.tsx|Login\.tsx|Dashboard\.tsx|DesignSystem|TrustCenter|MessagesHome|RelayBoard|OpsRunner|SupportPage|KioskPage|ClientDetail/;

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const targets = args.length ? args : files('src/pages').filter((f) => !EXCLUDE.test(f));
const report = { converted: [], skipped: [] };
for (const f of targets) {
  let text = readFileSync(f, 'utf8');
  if (!/<PageHeader\b/.test(text) || /Template\b/.test(text)) continue;
  // return ( <div className="…"> <PageHeader …/>  — the header is the root's first child.
  // The header's own close: `/>` on its own line at the header's indent, or a one-liner ` />`.
  // Root div (className optional), an optional pull-to-refresh indicator, then the header.
  const re = /return \(\n( +)<div(?: className="([^"]*)")?>\n(?:\1  (<PullToRefreshIndicator state=\{pullState\} \/>)\n)?(\1  )<PageHeader\b(?:([^\n]*?) \/>|([\s\S]*?)\n\4\/>)\n/g;
  let m;
  let changed = false;
  let out = text;
  let offset = 0;
  while ((m = re.exec(text))) {
    const indent = m[1];
    const rootClass = m[2];
    const pull = m[3];
    let props = m[5] ?? m[6];
    const start = m.index + offset;
    const closeNeedle = `\n${indent}</div>\n${indent.slice(2)});\n`;
    const closeAt = out.indexOf(closeNeedle, start + m[0].length);
    if (closeAt < 0) { report.skipped.push(`${f}: root close not found`); continue; }
    // Header className is the header's alone.
    // Only the header's own prop (at the header's prop indent), never a nested element's.
    props = props.replace(new RegExp(`(\\n${indent}    )className=`), '$1headerClassName=');
    // One-line `<PageHeader title="…" />` leaves props starting with a space.
    const propsText = props.trimEnd();
    const classProp = rootClass ? `\n${indent}    className="${rootClass}"` : '';
    const propsBlock = `${classProp}${propsText.startsWith('\n') ? propsText : `\n${indent}    ${propsText.trim()}`}`;
    const comment = 'Design system §4.2 (UX upgrade step 6, the sweep): the List template.';
    // With a pull-to-refresh indicator the page is a fragment: the indicator, then the template.
    const head = pull
      ? `return (\n${indent}<>\n${indent}  ${pull}\n${indent}  {/* ${comment} */}\n${indent}  <ListTemplate${propsBlock}\n${indent}  >\n`
      : `return (\n${indent}// ${comment}\n${indent}<ListTemplate${propsBlock}\n${indent}>\n`;
    const before = out.slice(0, start);
    const middle = out.slice(start + m[0].length, closeAt);
    const after = out.slice(closeAt + closeNeedle.length);
    const tail = pull ? `\n${indent}  </ListTemplate>\n${indent}</>\n${indent.slice(2)});\n` : `\n${indent}</ListTemplate>\n${indent.slice(2)});\n`;
    out = before + head + middle + tail + after;
    offset += head.length - m[0].length + tail.length - closeNeedle.length;
    changed = true;
  }
  if (!changed) { report.skipped.push(`${f}: header is not the root's first child`); continue; }
  if (!/<PageHeader\b/.test(out)) out = out.replace(/import \{ PageHeader \} from '@\/components\/ui\/PageHeader';\n/, '');
  if (!/from '@\/components\/templates'/.test(out)) {
    out = out.replace(/(import [^\n]*\n)(?![\s\S]*\nimport )/, `$1import { ListTemplate } from '@/components/templates';\n`);
  }
  report.converted.push(f);
  if (write) writeFileSync(f, out);
}
console.log(`converted ${report.converted.length}${write ? '' : ' (dry run)'}:\n  ${report.converted.join('\n  ')}`);
console.log(`skipped ${report.skipped.length}:\n  ${report.skipped.join('\n  ')}`);
