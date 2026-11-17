// Mirrors the ludatronix eBay store into the stock API.
// Runs in a normal, visible Edge window because eBay blocks headless browsers and plain HTTP.
// Config: .env next to this file with SYNC_URL and SYNC_TOKEN.
// Usage: node mirror.mjs [--dry-run] [--force]

import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const env = Object.fromEntries(
  readFileSync(join(here, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const SELLER = 'ludatronix';
const PAGE_SIZE = 240;
const searchUrl = (page) => `https://www.ebay.com/sch/i.html?_ssn=${SELLER}&_ipg=${PAGE_SIZE}&_pgn=${page}`;

const CATEGORIES = [
  [/\bipads?\b/i, 'iPads'],
  [/\biphones?\b/i, 'iPhones'],
  [/\bgalaxy tab\b|\bsamsung tab\b/i, 'Samsung Tablets'],
  [/\bssd\b|\bnvme\b|\bhdd\b|\bheatsink\b|\bddr\d\b|\bram\b|\bpower supply\b|\bgpu\b|\bgraphics card\b|\bmotherboard\b/i, 'PC Parts'],
  [/\bgalaxy\b|\bpixel\b|\bmotorola\b/i, 'Android Phones'],
  [/\bmacbook\b|\blaptop\b|\bchromebook\b|\bthinkpad\b/i, 'Laptops'],
  [/\bapple watch\b|\bwatch\b/i, 'Watches'],
  [/\bcamera|gopro|canon|nikon|kodak|fujifilm|polaroid/i, 'Cameras'],
  [/\bswitch\b|\bplaystation\b|\bps[345]\b|\bxbox\b|\bnintendo\b|\bgame|\brog ally\b|\bsteam deck\b/i, 'Games & Consoles'],
  [/\bairpods?\b|\bheadphones?\b|\bbeats\b/i, 'Audio'],
];

function categorize(title) {
  for (const [re, name] of CATEGORIES) if (re.test(title)) return name;
  return 'Other';
}

async function scrapePage(page, n) {
  await page.goto(searchUrl(n), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('li[data-listingid]', { timeout: 30000 });
  await page.waitForTimeout(2500 + Math.random() * 2000);
  return page.evaluate((seller) => {
    const CONDITION = /^(brand new|new|new \(other\)|open box|pre-owned|used|parts only|for parts or not working|(certified|excellent|very good|good) - refurbished|seller refurbished|refurbished)$/i;
    const out = [];
    for (const li of document.querySelectorAll('li[data-listingid]')) {
      const text = li.innerText || '';
      if (!text.toLowerCase().includes(seller)) continue;
      const id = li.dataset.listingid;
      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
      const titleEl = li.querySelector('.s-card__title');
      let title = (titleEl ? titleEl.innerText : '').replace(/Opens in a new window or tab/gi, '').replace(/^New listing\s*/i, '').trim();
      if (!title) title = (li.querySelector('img')?.alt || '').replace(/\s*Image \d+ of \d+$/, '').trim();
      const priceText = (li.querySelector('.s-card__price')?.innerText || lines.find((l) => /^\$[\d,]+\.\d{2}/.test(l)) || '');
      const price = Number((priceText.match(/\$([\d,]+\.\d{2})/) || [])[1]?.replace(/,/g, ''));
      const condition = lines.find((l) => CONDITION.test(l)) || '';
      const image = li.querySelector('img.s-card__image, img')?.src || '';
      if (id && title && price > 0) out.push({ id, title, ebayPrice: price, condition, image, ebayUrl: `https://www.ebay.com/itm/${id}` });
    }
    return { items: out, cards: document.querySelectorAll('li[data-listingid]').length };
  }, SELLER);
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--window-position=-2400,0'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const byId = new Map();
  try {
    for (let n = 1; n <= 20; n++) {
      const { items, cards } = await scrapePage(page, n);
      let added = 0;
      for (const it of items) if (!byId.has(it.id)) { byId.set(it.id, it); added++; }
      console.log(`page ${n}: ${cards} cards, ${items.length} from ${SELLER}, ${added} new`);
      if (cards < PAGE_SIZE * 0.9 || added === 0) break;
    }
  } finally {
    await browser.close();
  }

  const listings = [...byId.values()].map((it) => {
    const lot = it.title.match(/\b(?:bulk\s+)?lot\s+of\s+(\d+)/i);
    return { ...it, category: categorize(it.title), isLot: !!lot, quantity: lot ? Number(lot[1]) : null };
  });

  mkdirSync(join(here, 'logs'), { recursive: true });
  writeFileSync(join(here, 'logs', 'last-mirror.json'), JSON.stringify({ at: new Date().toISOString(), listings }, null, 1));
  console.log(`${listings.length} listings scraped`);
  if (args.has('--dry-run')) return;

  const res = await fetch(`${env.SYNC_URL}${args.has('--force') ? '?force=1' : ''}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.SYNC_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listings }),
  });
  const body = await res.text();
  console.log(`sync ${res.status}: ${body}`);
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
