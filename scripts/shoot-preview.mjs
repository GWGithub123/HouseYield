/**
 * Photographs the layout harness pages in `tmp-preview/`.
 *
 * Builds the project stylesheet first, because the harness markup is plain
 * Tailwind class names and says nothing about layout without it. Then loads
 * each page at the widths where this layout changes shape — the fact rail
 * moves beside the visual at xl, and two-up below it under that.
 *
 *   node scripts/shoot-preview.mjs [--widths 1600,1280,1024]
 *
 * Run `npx vitest run src/components/property/__preview__` first to write the
 * pages. PNGs land next to them in `tmp-preview/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
// From @playwright/test rather than `playwright`: the two can resolve to
// different versions, and only the pinned one has browsers downloaded.
import { chromium } from '@playwright/test';

const OUT = 'tmp-preview';

const widthArg = process.argv.indexOf('--widths');
const WIDTHS = widthArg === -1
  ? [1600, 1280, 1024]
  : process.argv[widthArg + 1].split(',').map((w) => Number(w.trim()));

if (!existsSync(OUT)) {
  console.error(`No ${OUT}/. Run: npx vitest run src/components/property/__preview__`);
  process.exit(1);
}

console.log('building stylesheet…');
execFileSync(
  'npx',
  ['tailwindcss', '-i', 'src/index.css', '-o', `${OUT}/app.css`, '--minify'],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

const pages = readdirSync(OUT).filter((f) => f.endsWith('.html'));
if (pages.length === 0) {
  console.error(`No .html in ${OUT}/. Run the preview test first.`);
  process.exit(1);
}

const browser = await chromium.launch();

for (const file of pages) {
  const name = file.replace(/\.html$/, '');
  for (const width of WIDTHS) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
    });
    await page.goto(pathToFileURL(resolve(OUT, file)).href);
    await page.waitForLoadState('networkidle');

    const shot = `${OUT}/${name}@${width}.png`;
    await page.screenshot({ path: shot, fullPage: true });

    // The numbers that actually answer the complaint: how tall the card is and
    // how much of the visual column is empty next to the rail.
    const metrics = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="property-twin-card"]');
      if (!card) return null;
      const visual = card.querySelector('.min-h-\\[360px\\]');
      const rail = card.querySelector('aside');
      return {
        card: Math.round(card.getBoundingClientRect().height),
        visual: visual ? Math.round(visual.getBoundingClientRect().height) : null,
        rail: rail ? Math.round(rail.getBoundingClientRect().height) : null,
      };
    });

    // A block that ends up a sliver inside a wide parent is almost always a
    // grid item missing its span — the failure that squeezed the value and tax
    // charts into 1/12 of the row. Pills and segmented controls are legitimately
    // narrow, so this only flags elements that overflow their own box, which is
    // what a squeezed chart does and a small control does not.
    const collapsed = await page.evaluate(() =>
      [...document.querySelectorAll('div,section,aside')]
        .filter((el) => {
          const w = el.getBoundingClientRect().width;
          const pw = el.parentElement?.getBoundingClientRect().width ?? 0;
          return pw > 400 && w > 0 && w < 160 && el.scrollHeight > el.clientHeight + 4;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 60)}`)
        .slice(0, 5));

    console.log(
      `${shot}  card=${metrics?.card}px visual=${metrics?.visual}px rail=${metrics?.rail}px`
      + (collapsed.length ? `\n   ⚠ collapsed: ${collapsed.join(' | ')}` : ''),
    );
    await page.close();
  }
}

await browser.close();
console.log('done');
