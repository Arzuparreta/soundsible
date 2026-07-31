#!/usr/bin/env node
/**
 * Report CSS-module classes that no source file references.
 *
 * CSS modules hide dead rules well: the class disappears from the JSX and the
 * stylesheet keeps shipping it. Selectors are read only outside url()/content
 * strings, so the inline SVG data URIs used for backgrounds don't register as
 * `.w3` / `.org`.
 *
 * Usage: node scripts/find-dead-css.mjs [--fail]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(SRC);
const sources = files
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/** Strip url(...) and quoted strings so data URIs can't look like selectors. */
function selectorsOnly(css) {
  return css.replace(/url\([^)]*\)/g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '');
}

let dead = 0;
for (const file of files.filter((f) => f.endsWith('.module.css')).sort()) {
  const css = readFileSync(file, 'utf8');
  const classes = new Set([...selectorsOnly(css).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const unused = [...classes]
    .filter((name) => !new RegExp(`\\b${name}\\b`).test(sources))
    // `composes:` targets are referenced from CSS, not from TS.
    .filter((name) => !new RegExp(`composes:[^;]*\\b${name}\\b`).test(css))
    .sort();
  if (unused.length) {
    dead += unused.length;
    console.log(`${relative(ROOT, file)}  (${unused.length}/${classes.size})`);
    console.log(`    ${unused.join(' ')}`);
  }
}

console.log(dead ? `\n${dead} unused class(es).` : '\nNo unused classes.');
if (dead && process.argv.includes('--fail')) process.exit(1);
