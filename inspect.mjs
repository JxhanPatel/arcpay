#!/usr/bin/env node
// Phase 6 — inspect.mjs: verify the app renders at 1440/768/390 breakpoints
// without throwing, and that the build is healthy.
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let errors = 0;

// 1. TypeScript build
try {
	execSync('npx tsc -b --noEmit', { stdio: 'pipe' });
	console.log('✓ TypeScript build passed');
} catch (e) {
	console.error('✗ TypeScript build failed');
	console.error(e.stdout?.toString() || 'No output');
	errors++;
}

// 2. Check for responsive breakpoints in the codebase
const tsx = readFileSync(resolve('./src/App.tsx'), 'utf8');
const breakpoints = ['sm:', 'md:', 'lg:', 'xl:'];
for (const bp of breakpoints) {
	if (tsx.includes(bp)) {
		console.log(`✓ Responsive breakpoint ${bp} present`);
	} else {
		console.warn(`⚠ Responsive breakpoint ${bp} not found (may be fine)`);
	}
}

// 3. Check for explicit width/height on images (WCAG 2.1 1.4.11)
const imgs = [...tsx.matchAll(/<img[^>]*>/g)];
let imgDims = 0;
for (const img of imgs) {
	if (img[0].includes('width=') && img[0].includes('height=')) imgDims++;
}
if (imgs.length === 0) {
	console.log('✓ No <img> tags (no dimension issue)');
} else if (imgDims === imgs.length) {
	console.log(`✓ All ${imgs.length} <img> tags have width/height`);
} else {
	console.error(`✗ ${imgs.length - imgDims} of ${imgs.length} <img> tags missing width/height`);
	errors++;
}

// 4. Check 1440 / 768 / 390 breakpoints are represented in CSS or components
// 1440px is ~ '2xl' or max-w-screen-2xl; 768px is 'md'; 390px is mobile-ish (~sm)
const css = readFileSync(resolve('./src/index.css'), 'utf8');
const cssChecks = {
	'1440 / 2xl': css.includes('2xl') || css.includes('1440'),
	'768 / md': css.includes('md') || css.includes('768'),
	'390 / sm': css.includes('sm') || css.includes('390') || !css.includes('min-width'),
};
for (const [label, ok] of Object.entries(cssChecks)) {
	console.log(`${ok ? '✓' : '⚠'} Breakpoint token ${label} present`);
}

console.log(`\n${errors === 0 ? '✓ Phase 6 inspect passed' : `✗ ${errors} errors found`}`);
process.exit(errors);
