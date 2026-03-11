// AI Radar Backend — Writer (src/writer.js)
// Writes all JSON output files with smart change detection
// Items are filed under their ACTUAL publication date, not today's date

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { log, todayKey, MONTH_NAMES } from "./utils.js";

const DATA_DIR = "./data";

// ── Load existing day file ────────────────────────────────────────────────────

export async function loadExistingDay(dateKey) {
  const path = dayFilePath(dateKey);
  try {
    if (!existsSync(path)) return [];
    const raw  = readFileSync(path, "utf8");
    const data = JSON.parse(raw);
    return data.items || [];
  } catch {
    return [];
  }
}

// ── Write all files ───────────────────────────────────────────────────────────

export async function writeAllFiles({ items, trending, summary, dateKey }) {
  ensureDir(DATA_DIR);

  // ── Group items by their ACTUAL publication date ──────────────────────────
  // Items are filed under the date they were published, not today
  const today        = dateKey; // e.g. "11-03-2026"
  const byDate       = groupByDate(items);
  const todayItems   = byDate[today] || [];
  const otherDates   = Object.entries(byDate).filter(([d]) => d !== today);

  log(`Items by date: today=${todayItems.length}, other dates=${otherDates.reduce((a,[,v])=>a+v.length,0)}`);

  // ── Write today's files ───────────────────────────────────────────────────

  const breaking = todayItems
    .filter(i => i.score >= 9)
    .slice(0, 10);

  const latest = {
    generatedAt: new Date().toISOString(),
    date:        today,
    count:       todayItems.length,
    summary:     summary || null,
    items:       todayItems.slice(0, 60),
  };

  const breakingOut = {
    generatedAt: new Date().toISOString(),
    count:       breaking.length,
    items:       breaking,
  };

  const todayDayData = {
    generatedAt: new Date().toISOString(),
    date:        today,
    count:       todayItems.length,
    summary:     summary || null,
    items:       todayItems,
  };

  // Write today's archive file
  const todayPath = dayFilePath(today);
  ensureDir(todayPath.split("/").slice(0, -1).join("/"));
  smartWrite(todayPath, todayDayData);

  // Write latest.json — only today's items
  smartWrite(`${DATA_DIR}/latest.json`, latest);

  // Write breaking.json — only today's breaking
  smartWrite(`${DATA_DIR}/breaking.json`, breakingOut);

  // Write trending.json
  if (trending) smartWrite(`${DATA_DIR}/trending.json`, trending);

  // ── Write other date archive files ────────────────────────────────────────
  // Old articles go into their correct historical date files

  for (const [dateStr, dateItems] of otherDates) {
    // Load existing items for that date and merge (don't overwrite)
    const existingItems = await loadExistingDay(dateStr);
    const existingUrls  = new Set(existingItems.map(i => i.url));
    const newForDate    = dateItems.filter(i => !existingUrls.has(i.url));

    if (!newForDate.length) continue;

    const merged = [...existingItems, ...newForDate].sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );

    const dateDayData = {
      generatedAt: new Date().toISOString(),
      date:        dateStr,
      count:       merged.length,
      summary:     null,
      items:       merged,
    };

    const datePath = dayFilePath(dateStr);
    ensureDir(datePath.split("/").slice(0, -1).join("/"));
    smartWrite(datePath, dateDayData);
    updateIndex(dateStr);
    log(`  Filed ${newForDate.length} items under ${dateStr}`);
  }

  // ── Update index and metadata ─────────────────────────────────────────────

  updateIndex(today);

  writeMetadata(todayItems, trending);

  log(`Wrote ${todayItems.length} items to today (${today}), latest.json, breaking.json (${breaking.length} items)`);
}

// ── Group items by actual publication date ────────────────────────────────────

function groupByDate(items) {
  const grouped = {};
  for (const item of items) {
    const dateKey = timestampToDateKey(item.timestamp);
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(item);
  }
  return grouped;
}

function timestampToDateKey(timestamp) {
  try {
    const d  = new Date(timestamp);
    if (isNaN(d.getTime())) return todayKey(); // fallback to today if invalid
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}-${mm}-${d.getFullYear()}`;
  } catch {
    return todayKey();
  }
}

// ── Smart write — skip if content unchanged ───────────────────────────────────

function smartWrite(path, data) {
  const json = JSON.stringify(data, null, 2);
  const hash = createHash("md5").update(json).digest("hex");

  if (existsSync(path)) {
    const existing     = readFileSync(path, "utf8");
    const existingHash = createHash("md5").update(existing).digest("hex");
    if (hash === existingHash) {
      log(`  Skipping ${path} — no changes`);
      return false;
    }
  }

  writeFileSync(path, json);
  log(`  Wrote ${path}`);
  return true;
}

// ── Index.json management ─────────────────────────────────────────────────────

function updateIndex(dateKey) {
  const indexPath = `${DATA_DIR}/index.json`;
  let dates = [];

  if (existsSync(indexPath)) {
    try {
      dates = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch { dates = []; }
  }

  if (!dates.includes(dateKey)) {
    dates.unshift(dateKey);
    dates.sort((a, b) => {
      const toMs = k => {
        const [dd, mm, yyyy] = k.split("-");
        return new Date(`${yyyy}-${mm}-${dd}`).getTime();
      };
      return toMs(b) - toMs(a);
    });
    writeFileSync(indexPath, JSON.stringify(dates, null, 2));
    log(`  Updated index.json (${dates.length} dates)`);
  }
}

// ── Metadata.json ─────────────────────────────────────────────────────────────
// Uses today-only items so popup numbers match dashboard numbers

function writeMetadata(todayItems, trending) {
  const meta = {
    lastUpdated:  new Date().toISOString(),
    todayCount:   todayItems.length,
    highCount:    todayItems.filter(i => i.priority === "HIGH").length,
    mediumCount:  todayItems.filter(i => i.priority === "MEDIUM").length,
    topTrending:  trending?.trending?.slice(0, 3) || [],
    version:      "2.0.0",
    sourceCount:  26,
  };
  smartWrite(`${DATA_DIR}/metadata.json`, meta);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dayFilePath(dateKey) {
  const [dd, mm, yyyy] = dateKey.split("-");
  const month = MONTH_NAMES[parseInt(mm, 10) - 1];
  return `${DATA_DIR}/${yyyy}/${month}/${dateKey}.json`;
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}
