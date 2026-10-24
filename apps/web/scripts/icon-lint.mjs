#!/usr/bin/env node
/**
 * Icon lint (docs/design-system.md, "Icons"). Parses every TSX file under
 * src/ with the TypeScript compiler — real JSX, not regexes — and fails on:
 *
 *   unlabeled     a button or link whose only content is an icon, with no
 *                 accessible name (aria-label, aria-labelledby, title, or a
 *                 visually hidden child). A screen reader would say
 *                 "button" and nothing else.
 *   stroke        a strokeWidth prop on a Lucide icon up to 24px. Stroke
 *                 weight is set once, per size, in index.css; `icon-bold`
 *                 is the one sanctioned emphasis. (From h-8 an icon is an
 *                 illustration and its line may be set for it.)
 *   size          an icon sized off the scale (h-2.5 10px only as a mark inside
 *                 a badge, h-3 12px inline with text-xs,
 *                 h-3.5 14px in dense rows, h-4 16px default, h-5 20px,
 *                 h-6 24px, h-8 32px and up for empty states), or with a
 *                 width that isn't its height.
 *
 *   node scripts/icon-lint.mjs            check
 *   node scripts/icon-lint.mjs --list     print every finding
 *
 * A control whose props are spread from elsewhere ({...p}) is trusted: its
 * name may come in with them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/** Elements a person activates. */
const CONTROLS = new Set([
  'button', 'a', 'Button', 'Link', 'NavLink', 'IconButton',
  // Radix parts that render a button unless asChild hands it on.
  'DialogClose', 'DrawerClose', 'SheetClose', 'PopoverTrigger', 'DropdownMenuTrigger', 'TooltipTrigger',
  'TabsTrigger', 'ToggleGroupItem', 'Toggle', 'CollapsibleTrigger', 'AccordionTrigger', 'SelectTrigger',
]);
const NAME_ATTRS = new Set(['aria-label', 'aria-labelledby', 'title']);
const SIZE_OK = new Set(['2.5', '3', '3.5', '4', '5', '6', '8', '10', '12', '14', '16']);
/** From h-8 an icon is an illustration: its line scales with it, and may be set for it. */
const ILLUSTRATION = (h) => h !== undefined && Number(h) >= 8;

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      files(p, out);
    } else if (/\.tsx$/.test(name) && !/\.(test|stories)\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const tagName = (el) => el.tagName.getText();

function attrs(el) {
  const out = new Map();
  let spread = false;
  for (const a of el.attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) spread = true;
    else out.set(a.name.getText(), a);
  }
  return { out, spread };
}

function stringAttr(a) {
  if (!a?.initializer) return null;
  if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
  if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
    const e = a.initializer.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    // cn('…', …) / template: read the literal parts.
    return e.getText();
  }
  return null;
}

function opening(node) {
  return ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
}

/** The children that carry content (whitespace-only text dropped). */
function contentChildren(node) {
  if (!ts.isJsxElement(node)) return [];
  return node.children.filter((c) => !(ts.isJsxText(c) && c.getText().trim() === '') && !(ts.isJsxExpression(c) && !c.expression));
}

function hasHiddenText(node) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    const o = opening(n);
    if (o) {
      const cls = stringAttr(attrs(o).out.get('className')) ?? '';
      if (/\bsr-only\b/.test(cls)) found = true;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

const findings = [];

for (const file of files(SRC)) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const icons = new Set();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.moduleSpecifier.text === 'lucide-react' && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const el of st.importClause.namedBindings.elements) icons.add(el.name.text);
    }
  }
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const at = (n) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const isIcon = (n) => {
    const o = opening(n);
    return !!o && icons.has(tagName(o));
  };
  /** An icon, or an expression that can only ever be one: {open ? <ChevronUp/> : <ChevronDown/>}, {busy && <Loader2/>}. */
  const iconOnly = (n) => {
    if (isIcon(n)) return true;
    let e = ts.isJsxExpression(n) ? n.expression : n;
    while (e && ts.isParenthesizedExpression(e)) e = e.expression;
    if (!e) return false;
    if (ts.isConditionalExpression(e)) return iconOnly(e.whenTrue) && iconOnly(e.whenFalse);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return iconOnly(e.right);
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) return isIcon(e);
    return false;
  };

  const namedByParent = new Set();
  const visit = (node) => {
    const o = opening(node);
    if (o) {
      const tag = tagName(o);
      const { out, spread } = attrs(o);
      // An icon handed in as a value (`icon: Icon`, `const Icon = …`) is still a Lucide icon.
      if (!icons.has(tag) && /^(?:Icon|[A-Z]\w*Icon)$/.test(tag) && out.has('strokeWidth')) {
        findings.push({ rule: 'stroke', where: at(o), what: `${tag} strokeWidth` });
      }
      if (icons.has(tag)) {
        const cls = stringAttr(out.get('className')) ?? '';
        const h = /(?:^|\s|['"`])h-(\d+(?:\.5)?)(?=$|\s|['"`])/.exec(cls)?.[1];
        const w = /(?:^|\s|['"`])w-(\d+(?:\.5)?)(?=$|\s|['"`])/.exec(cls)?.[1];
        if (out.has('strokeWidth') && !ILLUSTRATION(h)) findings.push({ rule: 'stroke', where: at(o), what: `${tag} strokeWidth` });
        if (h && !SIZE_OK.has(h)) findings.push({ rule: 'size', where: at(o), what: `${tag} h-${h}` });
        else if (h && w && h !== w) findings.push({ rule: 'size', where: at(o), what: `${tag} h-${h} w-${w}` });
      }
      const isControl = CONTROLS.has(tag) || stringAttr(out.get('role')) === 'button';
      const handsOn = out.has('asChild');
      // Deliberately out of the accessibility tree (a tree row's own toggle,
      // when the row announces expanded/collapsed itself).
      const hidden = stringAttr(out.get('aria-hidden')) === 'true';
      // <Button asChild title="…"><Link><Icon/></Link></Button>: the name rides down with the props.
      const named = [...NAME_ATTRS].some((k) => out.has(k)) || namedByParent.has(node);
      if (isControl && handsOn && named) {
        for (const k of contentChildren(node)) namedByParent.add(k);
      }
      // A Button sized as an icon button is icon-only by design, whatever renders inside.
      const iconSized = /^icon/.test(stringAttr(out.get('size')) ?? '');
      if (isControl && iconSized && !handsOn && !hidden && !spread && !named && !hasHiddenText(node)) {
        findings.push({ rule: 'unlabeled', where: at(o), what: `<${tag} size="icon…"> without a name` });
      } else if (isControl && !handsOn && !hidden && !spread && !named) {
        const kids = contentChildren(node);
        if (kids.length > 0 && kids.every((k) => iconOnly(k)) && !hasHiddenText(node)) {
          findings.push({ rule: 'unlabeled', where: at(o), what: `<${tag}> with only an icon` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const by = (r) => findings.filter((f) => f.rule === r);
const summary = ['unlabeled', 'stroke', 'size'].map((r) => `${r}=${by(r).length}`).join(' ');
if (process.argv.includes('--list') || findings.length > 0) {
  for (const f of findings) console.log(`  ${f.rule.padEnd(9)} ${f.where}  ${f.what}`);
}
console.log(`icon-lint: ${summary}`);
process.exit(findings.length > 0 ? 1 : 0);
