/** Prevent new native-control and literal-style debt outside the design system.
 * Existing debt is recorded per file; removing it never permits a new file to
 * introduce it. JSX is parsed, so comments and example strings do not count. */
import { parse } from '@babel/parser';
import postcss from 'postcss';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export function controlDebt(source) {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  let count = 0;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXOpeningElement' && node.name?.type === 'JSXIdentifier'
        && ['button', 'input', 'select', 'textarea'].includes(node.name.name)) count++;
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  return count;
}

export function styleDebt(source) {
  let count = 0;
  postcss.parse(source).walkDecls(declaration => {
    if (declaration.prop.startsWith('--')) return;
    // Constants inside fallback var() values remain debt too. Native border
    // hairlines and zero are allowed; recipe sizes and colours need tokens.
    const rawColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(declaration.value);
    const rawSize = /(?:^|[^\w.-])(?:[2-9]\d*|1\d+|\d+\.\d+)px\b/.test(declaration.value);
    if (rawColor || rawSize) count++;
  });
  return count;
}

export function regressions(current, baseline) {
  return Object.entries(current).flatMap(([file, debt]) => Object.entries(debt)
    .filter(([kind, count]) => count > (baseline[file]?.[kind] ?? 0))
    .map(([kind, count]) => `${file}: ${kind} ${count} exceeds ${baseline[file]?.[kind] ?? 0}`));
}

function run() {
  const root = resolve(import.meta.dirname, '..');
  const baselinePath = resolve(root, 'scripts/design-baseline.json');
  const current = {};
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      const file = relative(root, path);
      if (/\.(test|spec)\./.test(file) || file === 'src/styles/tokens.css') continue;
      if (file.startsWith('src/design/') && (!file.endsWith('.tsx')
          || ['Control.tsx', 'Field.tsx', 'Button.tsx'].includes(name))) continue;
      const source = readFileSync(path, 'utf8');
      const debt = path.endsWith('.tsx') ? { controls: controlDebt(source) }
        : path.endsWith('.css') ? { styles: styleDebt(source) } : {};
      if (Object.values(debt).some(count => count > 0)) current[file] = debt;
    }
  }
  walk(resolve(root, 'src'));
  if (process.argv.includes('--update')) {
    writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n');
    console.log('Recorded the design debt baseline. Review its diff before committing.');
    return;
  }
  const failures = regressions(current, JSON.parse(readFileSync(baselinePath, 'utf8')));
  if (failures.length) throw new Error(`New design debt:\n${failures.join('\n')}\nUse src/design primitives and semantic tokens.`);
  console.log('Design debt stays within the checked-in baseline.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();
