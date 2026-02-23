#!/usr/bin/env node
/**
 * MFL Salary Top 30 Exporter
 *
 * Fetches salary data from MyFantasyLeague.com for league 13522 across
 * seasons 2021-2025 and exports the top 30 salaries per position to
 * an Excel workbook.
 *
 * Data sources per year (four sources, merged with max salary per player):
 *   1. Week 1 rosters — carry-over contracts from previous years
 *   2. Week 14 rosters — mid-season state with carry-over contracts
 *   3. Auction results — authoritative winning bids for newly-auctioned players
 *      (the roster salary field does NOT reliably reflect auction bids)
 *   4. BBID_WAIVER transactions — mid-season waiver claims with exact bid amounts
 *
 * Together these capture every player who held a salary at any point
 * during the season, including players who were later dropped.
 */

import XLSX from 'xlsx-js-style';

// ── Configuration ────────────────────────────────────────────────────

const LEAGUE_ID = '13522';
const BASE_URL = 'https://www49.myfantasyleague.com';
const YEARS = [2021, 2022, 2023, 2024, 2025];
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'PK', 'Def'];
const TOP_N = 30;
const REQUEST_DELAY_MS = 1000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1500;

// Team-aggregate positions to exclude from output
const EXCLUDED_POSITIONS = new Set([
  'TMWR', 'TMRB', 'TMDL', 'TMTE', 'TMQB', 'TMPK', 'TMPN', 'TMLB', 'TMDB',
  'ST', 'Off', 'HB', 'CB', 'DB', 'DL', 'LB', 'S', 'DE', 'DT', 'FB',
]);

// ── Helpers ──────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** MFL sometimes returns a single object instead of an array. */
function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Convert MFL "Last, First" name format to "First Last".
 * Also handles defenses: "Bills, Buffalo" -> "Buffalo Bills".
 */
function formatName(mflName) {
  if (!mflName) return 'Unknown';
  const match = mflName.match(/^([^,]+),\s*(.+)$/);
  if (!match) return mflName;
  return `${match[2].trim()} ${match[1].trim()}`;
}

/**
 * Normalize position strings to canonical form.
 * Returns null for unrecognized / excluded positions.
 */
function normalizePosition(pos) {
  if (!pos) return null;
  if (EXCLUDED_POSITIONS.has(pos)) return null;
  const upper = pos.toUpperCase();
  if (upper === 'DEF') return 'Def';
  if (upper === 'K') return 'PK';
  const map = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', PK: 'PK', DEF: 'Def' };
  return map[upper] || null;
}

/**
 * Merge a salary map into an accumulator, keeping the max salary per player.
 */
function mergeInto(target, source) {
  for (const [playerId, salary] of source) {
    const existing = target.get(playerId) || 0;
    target.set(playerId, Math.max(existing, salary));
  }
}

// ── API Layer ────────────────────────────────────────────────────────

async function fetchJson(url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      // MFL sometimes returns error objects
      if (data?.error) {
        throw new Error(`MFL error: ${JSON.stringify(data.error)}`);
      }
      return data;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Failed after ${MAX_RETRIES} attempts: ${url} — ${err.message}`);
      }
      const wait = RETRY_BACKOFF_MS * attempt;
      console.warn(`  Retry ${attempt}/${MAX_RETRIES} in ${wait}ms (${err.message})`);
      await delay(wait);
    }
  }
}

function buildUrl(year, params) {
  const qs = new URLSearchParams({ L: LEAGUE_ID, JSON: '1', ...params });
  return `${BASE_URL}/${year}/export?${qs}`;
}

// ── Data Fetching ────────────────────────────────────────────────────

/**
 * Fetch rosters for a given year and week.
 * Returns Map<playerId, salary>.
 */
async function fetchRosters(year, week) {
  const url = buildUrl(year, { TYPE: 'rosters', W: String(week) });
  console.log(`  Rosters (W${week}):  ${url}`);
  const data = await fetchJson(url);

  const salaryMap = new Map();
  const franchises = ensureArray(data?.rosters?.franchise);
  for (const franchise of franchises) {
    const players = ensureArray(franchise?.player);
    for (const p of players) {
      if (!p?.id) continue;
      const salary = parseFloat(p.salary) || 0;
      if (salary > 0) {
        const existing = salaryMap.get(p.id) || 0;
        salaryMap.set(p.id, Math.max(existing, salary));
      }
    }
  }

  return salaryMap;
}

/**
 * Fetch auction results for a given year.
 * Returns Map<playerId, winningBid>.
 *
 * This is the authoritative source for newly-auctioned player salaries.
 * The roster salary field does NOT reliably reflect auction bids.
 */
async function fetchAuctionResults(year) {
  const url = buildUrl(year, { TYPE: 'auctionResults' });
  console.log(`  Auction Results: ${url}`);
  const data = await fetchJson(url);

  const salaryMap = new Map();
  const auctions = ensureArray(data?.auctionResults?.auctionUnit?.auction);

  for (const auction of auctions) {
    if (!auction?.player) continue;
    const bid = parseFloat(auction.winningBid) || 0;
    if (bid > 0) {
      const existing = salaryMap.get(auction.player) || 0;
      salaryMap.set(auction.player, Math.max(existing, bid));
    }
  }

  return salaryMap;
}

/**
 * Fetch BBID_WAIVER transactions for a given year.
 * Returns Map<playerId, salary> for all added players.
 *
 * Transaction format: "droppedIds|bidAmount|addedIds"
 *   e.g. "14867,|425000|13593," means drop 14867, bid $425K, add 13593
 */
async function fetchBbidTransactions(year) {
  const url = buildUrl(year, { TYPE: 'transactions', TRANS_TYPE: 'BBID_WAIVER', COUNT: '500' });
  console.log(`  BBID Waivers:    ${url}`);
  const data = await fetchJson(url);

  const salaryMap = new Map();
  const transactions = ensureArray(data?.transactions?.transaction);

  for (const tx of transactions) {
    if (!tx?.transaction) continue;

    // Format: "droppedIds|bidAmount|addedIds"
    const parts = tx.transaction.split('|');
    if (parts.length < 3) continue;

    const bidAmount = parseFloat(parts[1]) || 0;
    if (bidAmount <= 0) continue;

    // Added player IDs are in parts[2], comma-separated (with trailing comma)
    const addedIds = parts[2].split(',').map(s => s.trim()).filter(Boolean);
    for (const playerId of addedIds) {
      const existing = salaryMap.get(playerId) || 0;
      salaryMap.set(playerId, Math.max(existing, bidAmount));
    }
  }

  return salaryMap;
}

/**
 * Fetch player metadata for a given year.
 * Returns Map<playerId, { name, position }>.
 */
async function fetchPlayerMetadata(year) {
  const url = buildUrl(year, { TYPE: 'players', DETAILS: '1' });
  console.log(`  Players:         ${url}`);
  const data = await fetchJson(url);

  const playerMap = new Map();
  const players = ensureArray(data?.players?.player);

  for (const p of players) {
    if (!p?.id) continue;
    const pos = normalizePosition(p.position);
    if (!pos) continue;

    playerMap.set(p.id, {
      name: formatName(p.name),
      position: pos,
    });
  }

  return playerMap;
}

// ── Data Processing ──────────────────────────────────────────────────

/**
 * Group players by position, sort by salary descending, take top N.
 * Returns { position: [ { name, salary }, ... ] }
 */
function rankByPosition(salaryMap, playerMap) {
  const groups = {};
  for (const pos of POSITIONS) {
    groups[pos] = [];
  }

  for (const [playerId, salary] of salaryMap) {
    const meta = playerMap.get(playerId);
    if (!meta) continue;
    if (!groups[meta.position]) continue;

    groups[meta.position].push({ name: meta.name, salary });
  }

  const ranked = {};
  for (const pos of POSITIONS) {
    groups[pos].sort((a, b) => b.salary - a.salary);
    ranked[pos] = groups[pos].slice(0, TOP_N);
  }

  return ranked;
}

/**
 * Process all years: fetch four sources, merge, rank.
 * Returns { position: { year: [ { name, salary }, ... ] } }
 */
async function collectAllData() {
  const allData = {};
  for (const pos of POSITIONS) {
    allData[pos] = {};
  }

  for (const year of YEARS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Fetching ${year}...`);

    // Source 1: Week 1 rosters (carry-over contracts, dropped players)
    const rostersW1 = await fetchRosters(year, 1);
    await delay(REQUEST_DELAY_MS);

    // Source 2: Week 14 rosters (mid-season state)
    const rostersW14 = await fetchRosters(year, 14);
    await delay(REQUEST_DELAY_MS);

    // Source 3: Auction results (authoritative for newly-auctioned salaries)
    const auctionSalaries = await fetchAuctionResults(year);
    await delay(REQUEST_DELAY_MS);

    // Source 4: BBID waiver transactions (mid-season claims)
    const bbidSalaries = await fetchBbidTransactions(year);
    await delay(REQUEST_DELAY_MS);

    // Source 5: Player metadata (names + positions)
    const playerMap = await fetchPlayerMetadata(year);
    await delay(REQUEST_DELAY_MS);

    // Merge all four salary sources (max salary per player)
    const merged = new Map();
    mergeInto(merged, rostersW1);
    mergeInto(merged, rostersW14);
    mergeInto(merged, auctionSalaries);
    mergeInto(merged, bbidSalaries);

    const ranked = rankByPosition(merged, playerMap);

    console.log(`  W1: ${rostersW1.size} | W14: ${rostersW14.size} | Auction: ${auctionSalaries.size} | BBID: ${bbidSalaries.size} | Merged: ${merged.size}`);
    for (const pos of POSITIONS) {
      console.log(`    ${pos.padEnd(4)} top ${ranked[pos].length}`);
    }

    for (const pos of POSITIONS) {
      allData[pos][year] = ranked[pos];
    }
  }

  return allData;
}

// ── Excel Output ─────────────────────────────────────────────────────

// Style constants
const HEADER_FILL = { fgColor: { rgb: '2D3748' } };
const HEADER_FONT = { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 };
const SUBHEADER_FILL = { fgColor: { rgb: 'E2E8F0' } };
const SUBHEADER_FONT = { bold: true, sz: 10 };
const EVEN_ROW_FILL = { fgColor: { rgb: 'F7FAFC' } };
const CURRENCY_FMT = '$#,##0';
const CENTER = { horizontal: 'center', vertical: 'center' };
const LEFT = { horizontal: 'left', vertical: 'center' };
const RIGHT = { horizontal: 'right', vertical: 'center' };

function cell(value, type, style = {}) {
  return { v: value, t: type, s: style };
}

function buildPositionSheet(positionData) {
  const ws = {};
  const merges = [];
  const yearCount = YEARS.length;
  const totalCols = 1 + yearCount * 2;

  // ── Row 0: Year headers ──
  ws[XLSX.utils.encode_cell({ r: 0, c: 0 })] = cell(
    'Rank', 's', { font: HEADER_FONT, fill: HEADER_FILL, alignment: CENTER }
  );

  for (let yi = 0; yi < yearCount; yi++) {
    const col = 1 + yi * 2;
    ws[XLSX.utils.encode_cell({ r: 0, c: col })] = cell(
      YEARS[yi], 'n', { font: HEADER_FONT, fill: HEADER_FILL, alignment: CENTER }
    );
    ws[XLSX.utils.encode_cell({ r: 0, c: col + 1 })] = cell(
      '', 's', { font: HEADER_FONT, fill: HEADER_FILL }
    );
    merges.push({ s: { r: 0, c: col }, e: { r: 0, c: col + 1 } });
  }

  // ── Row 1: Sub-headers ──
  ws[XLSX.utils.encode_cell({ r: 1, c: 0 })] = cell(
    '', 's', { fill: SUBHEADER_FILL }
  );

  for (let yi = 0; yi < yearCount; yi++) {
    const col = 1 + yi * 2;
    ws[XLSX.utils.encode_cell({ r: 1, c: col })] = cell(
      'Player', 's', { font: SUBHEADER_FONT, fill: SUBHEADER_FILL, alignment: LEFT }
    );
    ws[XLSX.utils.encode_cell({ r: 1, c: col + 1 })] = cell(
      'Salary', 's', { font: SUBHEADER_FONT, fill: SUBHEADER_FILL, alignment: CENTER }
    );
  }

  // ── Data rows ──
  const maxRows = Math.max(
    ...YEARS.map(y => (positionData[y] || []).length),
    0
  );
  const rowCount = Math.min(maxRows, TOP_N);

  for (let ri = 0; ri < rowCount; ri++) {
    const excelRow = ri + 2; // offset for 2 header rows
    const isEven = ri % 2 === 0;
    const rowFill = isEven ? EVEN_ROW_FILL : undefined;

    const rankStyle = { alignment: CENTER };
    if (rowFill) rankStyle.fill = rowFill;
    ws[XLSX.utils.encode_cell({ r: excelRow, c: 0 })] = cell(ri + 1, 'n', rankStyle);

    for (let yi = 0; yi < yearCount; yi++) {
      const col = 1 + yi * 2;
      const players = positionData[YEARS[yi]] || [];
      const player = players[ri];

      const nameStyle = { alignment: LEFT };
      if (rowFill) nameStyle.fill = rowFill;
      ws[XLSX.utils.encode_cell({ r: excelRow, c: col })] = cell(
        player?.name || '', 's', nameStyle
      );

      const salaryStyle = { numFmt: CURRENCY_FMT, alignment: RIGHT };
      if (rowFill) salaryStyle.fill = rowFill;
      ws[XLSX.utils.encode_cell({ r: excelRow, c: col + 1 })] = player
        ? cell(Math.round(player.salary), 'n', salaryStyle)
        : cell('', 's', rowFill ? { fill: rowFill } : {});
    }
  }

  // ── Sheet metadata ──
  ws['!merges'] = merges;
  ws['!cols'] = [
    { wch: 6 },
    ...YEARS.flatMap(() => [{ wch: 25 }, { wch: 14 }]),
  ];
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: rowCount + 1, c: totalCols - 1 },
  });

  return ws;
}

function createWorkbook(allData) {
  const wb = XLSX.utils.book_new();

  for (const pos of POSITIONS) {
    const ws = buildPositionSheet(allData[pos]);
    XLSX.utils.book_append_sheet(wb, ws, pos);
  }

  return wb;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('MFL Salary Top 30 Exporter');
  console.log(`League: ${LEAGUE_ID} | Years: ${YEARS.join(', ')} | Positions: ${POSITIONS.join(', ')}`);
  console.log('Sources: W1 Rosters + W14 Rosters + Auction Results + BBID Waivers');

  try {
    const allData = await collectAllData();

    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `mfl-salary-top30-${timestamp}.xlsx`;

    const wb = createWorkbook(allData);
    XLSX.writeFile(wb, filename);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Done! Exported to ${filename}`);
  } catch (err) {
    console.error('\nFatal error:', err.message);
    process.exit(1);
  }
}

main();
