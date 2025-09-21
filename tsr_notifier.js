import fs from 'fs';
import axios from 'axios';
import { load } from 'cheerio';
import creators from './creators.json' assert { type: 'json' };

const BASE_URL = 'https://www.thesimsresource.com';
const WEBHOOK_URL = process.env.DISCORD_TSR_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error('❌ DISCORD_TSR_WEBHOOK_URL is not set in env!');
  process.exit(1);
}

const SENT_FILE = 'sent_posts.json';
const NEED_FILE = 'need_to_check.json';

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.warn(`⚠️ Failed to read ${file}, using fallback.`, e.message);
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

let sentPosts = readJson(SENT_FILE, []);
let needToCheck = readJson(NEED_FILE, []);

const wait = ms => new Promise(res => setTimeout(res, ms));

async function fetchCreatorPageNoFollow(url) {
  // Do not follow redirects so we can detect them.
  try {
    const resp = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: null, // allow investigating status ourselves
      headers: {
        // pretend to be a browser just in case
        'User-Agent': 'Mozilla/5.0 (compatible; TSR-Notifier/1.0; +https://github.com/your/repo)'
      },
      timeout: 20_000
    });
    return resp;
  } catch (err) {
    // Network-level error (timeout, DNS, socket)
    throw new Error(`Network error: ${err.message}`);
  }
}

function normalizeUrl(url) {
  if (!url) return null;
  return url.startsWith('http') ? url : `${BASE_URL}${url}`;
}

async function sendDiscord(creatorName, postUrl, imageUrl) {
  const payload = {
    embeds: [
      {
        title: `New TSR Post by ${creatorName}`,
        url: postUrl,
        color: 5814783,
        image: imageUrl ? { url: imageUrl } : undefined
      }
    ]
  };

  await axios.post(WEBHOOK_URL, payload, { timeout: 10000 });
}

async function scrapeCreator(creator) {
  const creatorRecord = { name: creator.name, url: creator.url };

  let resp;
  try {
    resp = await fetchCreatorPageNoFollow(creator.url);
  } catch (err) {
    console.error(`❌ ${creator.name} -> network error:`, err.message);
    // push to need_to_check with reason
    needToCheck.push({ ...creatorRecord, reason: 'network error', when: new Date().toISOString() });
    return;
  }

  // If server responded with a redirect (3xx) -> record as need_to_check
  if (resp.status >= 300 && resp.status < 400) {
    console.warn(`➡️ ${creator.name} redirected (status ${resp.status}). Marking for review.`);
    needToCheck.push({ ...creatorRecord, status: resp.status, reason: 'redirect', when: new Date().toISOString() });
    return;
  }

  // If not OK (>=400) -> record
  if (resp.status >= 400 || resp.status === 0 || resp.status === null) {
    console.warn(`❌ ${creator.name} returned status ${resp.status}. Marking for review.`);
    needToCheck.push({ ...creatorRecord, status: resp.status, reason: 'http error', when: new Date().toISOString() });
    return;
  }

  // If we got here, status is likely 200 -> parse HTML
  try {
    const $ = load(resp.data);
    const items = [];

    // same logic as your previous scraper: iterate .item-wrapper
    $('.item-wrapper').each((i, el) => {
      const link = $(el).find('.item-link').attr('href');
      if (!link) return;

      const absoluteLink = normalizeUrl(link);

      const bgStyle = $(el).find('.item-image').attr('style') || '';
      const imageMatch = bgStyle.match(/url\(['"]?(.*?)['"]?\)/);
      const absoluteImageUrl = imageMatch
        ? (imageMatch[1].startsWith('http') ? imageMatch[1] : `${BASE_URL}${imageMatch[1]}`)
        : null;

      items.push({ link: absoluteLink, image: absoluteImageUrl });
    });

    console.log(`🔎 ${creator.name}: found ${items.length} items.`);

    // For each item, check if already sent; if not, send to Discord and record it immediately
    for (const it of items) {
      if (!it.link) continue;
      if (sentPosts.includes(it.link)) continue;

      try {
        await sendDiscord(creator.name, it.link, it.image);
        console.log(`✅ Discord notified for ${it.link}`);
        sentPosts.push(it.link);
        writeJson(SENT_FILE, sentPosts);
        // small pause to avoid spamming
        await wait(2000);
      } catch (err) {
        console.error(`❌ Failed to send Discord for ${it.link}`, err.response ? `${err.response.status}` : err.message);
        // Do NOT mark sent if sending failed — keep it unsent for next run
      }
    }

  } catch (err) {
    console.error(`❌ Error parsing ${creator.name}:`, err.message);
    needToCheck.push({ ...creatorRecord, reason: 'parse error', when: new Date().toISOString() });
  }
}

(async () => {
  try {
    if (!Array.isArray(creators) || creators.length === 0) {
      console.error('❌ creators.json is empty or invalid. Provide an array of {name, url} objects.');
      process.exit(1);
    }

    // dedupe needToCheck entries in memory and load existing file entries to avoid duplicates
    const existingNeed = readJson(NEED_FILE, []);
    // keep existing ones and will append new, but avoid duplicate creator urls
    needToCheck = existingNeed.slice();

    for (const creator of creators) {
      // basic validation
      if (!creator || !creator.name || !creator.url) {
        console.warn('⚠️ Skipping invalid creator entry:', creator);
        continue;
      }
      // if this creator is already in needToCheck from previous run, skip scraping (so it's not spammy)
      const alreadyFlagged = needToCheck.some(n => n.url === creator.url);
      if (alreadyFlagged) {
        console.log(`⏭️ Skipping ${creator.name} — already flagged in ${NEED_FILE}`);
        continue;
      }

      await scrapeCreator(creator);
    }

    // remove duplicate needToCheck entries (by url)
    const dedupedNeed = [];
    const seen = new Set();
    for (const n of needToCheck) {
      if (!n.url) continue;
      if (seen.has(n.url)) continue;
      seen.add(n.url);
      dedupedNeed.push(n);
    }
    writeJson(NEED_FILE, dedupedNeed);

    // ensure sent_posts.json exists and is written
    writeJson(SENT_FILE, sentPosts);

    console.log('✔️ Run complete.');
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
})();
