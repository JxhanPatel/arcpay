#!/usr/bin/env node
// Phase 6 — lint.mjs: verify design-token consistency across the app
import { readFileSync, readdirSync } from 'fs';
const cssPath = './src/index.css';
const css = readFileSync(cssPath, 'utf8');

let errors = 0;

// Verify accent is copper #C2885B
if (!css.includes('#C2885B') && !css.includes('194 136 91')) {
  console.error('✗ Accent color #C2885B / (194 136 91) missing in CSS');
  errors++;
} else {
  console.log('✓ Accent copper #C2885B present');
}

// Verify reduced-motion guard exists
if (css.includes('@media (prefers-reduced-motion: reduce)')) {
  console.log('✓ Reduced-motion media query present');
} else {
  console.error('✗ Reduced-motion media query missing');
  errors++;
}

// Verify keyframes arc-reveal
if (css.includes('@keyframes arc-reveal')) {
  console.log('✓ arc-reveal keyframes present');
} else {
  console.error('✗ arc-reveal keyframes missing');
  errors++;
}

// Verify font-display / .text-display references
const tsxFiles = readdirSync('./src').filter(f => f.endsWith('.tsx')).map(f => `./src/${f}`);
const tsxContent = tsxFiles.map(p => readFileSync(p, 'utf8')).join('');

if (tsxContent.includes('.text-display') || tsxContent.includes('font-display')) {
  console.log('✓ .text-display / font-display referenced');
} else {
  console.error('✗ Display typography token not referenced');
  errors++;
}

// Verify focus-visible ring-offset + copper on interactive elements
if (tsxContent.includes('focus-visible:ring-offset-2') && tsxContent.includes('#C2885B')) {
  console.log('✓ focus-visible ring-offset + copper accent');
} else {
  console.error('✗ Focus-visible ring-offset or copper missing');
  errors++;
}

console.log(`\n${errors === 0 ? '✓ Phase 6 lint passed' : `✗ ${errors} errors found`}`);
process.exit(errors);
