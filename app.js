// VN Ward Converter — SQLite-only edition
// - YÊU CẦU: ward_mappings.sql phải là SQLite hợp lệ (CREATE TABLE ...; INSERT ...;)
// - KHÔNG còn chuyển MySQL -> SQLite. Nếu file là MySQL, hãy chuyển trước khi nạp.
// - Input/Output chỉ theo tên (Xã/Phường, Huyện/Quận, Tỉnh/Thành)

// ---------- Helpers ----------
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toRawUrl(url) {
  if (!url) return url;
  if (url.includes('raw.githubusercontent.com')) return url;
  if (url.includes('github.com') && url.includes('/blob/')) {
    return url.replace('github.com/', 'raw.githubusercontent.com/').replace('/blob/', '/');
  }
  return url;
}

function stripDiacritics(s) {
  return (s || '').normalize('NFD').replace(/\p{Diacritic}+/gu, '').toLowerCase().trim();
}

function sniffDelimiter(text) {
  if (text.includes('\t')) return '\t';
  const first = text.split(/\r?\n/)[0] || '';
  const c = (first.match(/,/g) || []).length;
  const sc = (first.match(/;/g) || []).length;
  return c >= sc ? ',' : ';';
}

function parseTable(text) {
  const t = (text || '').trim();
  if (!t) return { header: [], rows: [] };
  const delim = sniffDelimiter(t);
  const lines = t.split(/\r?\n/).filter((l) => l.trim().length);
  const rows = lines.map((l) => l.split(delim).map((c) => c.trim()));
  const HEAD = new Set([
    'old_ward_name', 'old_district_name', 'old_province_name',
    'new_ward_name', 'new_province_name',
    'ward_name', 'district_name', 'province_name',
  ]);
  const hasHeader = rows[0]?.some((h) => HEAD.has((h || '').toLowerCase()));
  const header = hasHeader ? rows[0] : ['old_ward_name','old_district_name','old_province_name'];
  return { header, rows: hasHeader ? rows.slice(1) : rows };
}

function joinTSV(rows) { return rows.map((r) => r.join('\t')).join('\n'); }

function getCol(cols, header, name) {
  const idx = header.findIndex((h) => (h || '').toLowerCase() === name.toLowerCase());
  return idx >= 0 ? (cols[idx] || '').trim() : '';
}

// ---------- SQL/DB ----------
let SQL; let db; let rowsCache = [];

async function loadSQLfromURL(url) {
  $('#sqlStatus').textContent = 'Đang tải SQL…';
  const raw = toRawUrl(url);
  const r = await fetch(raw, { cache: 'no-store' });
  if (!r.ok) throw new Error('Không tải được SQL: ' + r.status);
  const sqlText = await r.text();
  await initDB(sqlText);
  $('#sqlStatus').innerHTML = '<span class="ok">Đã nạp SQL thành công.</span>';
}

async function initDB(sqlText) {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${f}` });
  }
  db?.close?.();
  db = new SQL.Database();

  // Không chuyển MySQL → SQLite nữa; giả định file là SQLite chuẩn
  const safeSQL = sqlText.replace(/\r\n/g, "\n").replace(/;;+/g, ';');

  try {
    db.exec(safeSQL);
  } catch (e) {
    console.error('SQLite exec error:', e);
    console.log('SQL preview >>>\n', safeSQL.slice(0, 1500));
    throw e;
  }

  // Cache mapping table
  const res = db.exec(
    'SELECT old_ward_code,old_ward_name,old_district_name,old_province_name, new_ward_code,new_ward_name,new_province_name FROM ward_mappings'
  );
  const cols = res[0]?.columns || [];
  const data = res[0]?.values || [];
  rowsCache = data.map((v) => {
    const o = Object.fromEntries(cols.map((c, i) => [c, (v[i] ?? '') + '']));
    return {
      ...o,
      _old_ward_name: stripDiacritics(o.old_ward_name),
      _old_district_name: stripDiacritics(o.old_district_name),
      _old_province_name: stripDiacritics(o.old_province_name),
      _new_ward_name: stripDiacritics(o.new_ward_name),
      _new_province_name: stripDiacritics(o.new_province_name),
    };
  });
}

// ---------- Matching (names only) ----------
function matchOldToNew({ ward, district, province }) {
  const w = stripDiacritics(ward);
  const d = stripDiacritics(district);
  const p = stripDiacritics(province);
  let pool = rowsCache;
  if (p) pool = pool.filter((r) => r._old_province_name.includes(p) || r._new_province_name.includes(p));
  if (d) pool = pool.filter((r) => r._old_district_name.includes(d));
  if (w) pool = pool.filter((r) => r._old_ward_name.includes(w));
  return pool[0];
}

function matchNewToOld({ ward, province }) {
  const w = stripDiacritics(ward);
  const p = stripDiacritics(province);
  let pool = rowsCache;
  if (p) pool = pool.filter((r) => r._new_province_name.includes(p) || r._old_province_name.includes(p));
  if (w) pool = pool.filter((r) => r._new_ward_name.includes(w));
  return pool[0];
}

async function convertOne(mode, header, cols) {
  const oldWard = getCol(cols, header, 'old_ward_name');
  const oldDist = getCol(cols, header, 'old_district_name');
  const oldProv = getCol(cols, header, 'old_province_name');
  const newWard = getCol(cols, header, 'new_ward_name');
  const newProv = getCol(cols, header, 'new_province_name');
  const anyWard = getCol(cols, header, 'ward_name');
  const anyDist = getCol(cols, header, 'district_name');
  const anyProv = getCol(cols, header, 'province_name');

  let out = {
    old_ward_name: '',
    old_district_name: '',
    old_province_name: '',
    new_ward_name: '',
    new_province_name: '',
    direction: '',
  };

  try {
    if (mode === 'old2new') {
      const hit = matchOldToNew({
        ward: oldWard || anyWard,
        district: oldDist || anyDist,
        province: oldProv || anyProv,
      });
      if (hit) {
        out = {
          old_ward_name: hit.old_ward_name,
          old_district_name: hit.old_district_name,
          old_province_name: hit.old_province_name,
          new_ward_name: hit.new_ward_name,
          new_province_name: hit.new_province_name,
          direction: 'old->new',
        };
      }
    } else {
      const hit = matchNewToOld({
        ward: newWard || anyWard,
        province: newProv || anyProv,
      });
      if (hit) {
        out = {
          old_ward_name: hit.old_ward_name,
          old_district_name: hit.old_district_name,
          old_province_name: hit.old_province_name,
          new_ward_name: hit.new_ward_name,
          new_province_name: hit.new_province_name,
          direction: 'new->old',
        };
      }
    }
  } catch (e) { /* silent */ }

  return out;
}

// ---------- UI wiring ----------
$('#loadSqlBtn').addEventListener('click', async () => {
  const url = $('#sqlUrl').value.trim();
  if (!url) { $('#sqlStatus').innerHTML = '<span class="err">Hãy nhập URL SQL.</span>'; return; }
  try { await loadSQLfromURL(url); }
  catch (e) { $('#sqlStatus').innerHTML = '<span class="err">' + (e.message || e) + '</span>'; }
});

$('#loadSqlFileBtn').addEventListener('click', async () => {
  const f = $('#sqlFile').files?.[0];
  if (!f) { $('#sqlStatus').innerHTML = '<span class="err">Chưa chọn file .sql</span>'; return; }
  try {
    const text = await f.text();
    await initDB(text);
    $('#sqlStatus').innerHTML = '<span class="ok">Đã nạp SQL từ file.</span>';
  } catch (e) {
    $('#sqlStatus').innerHTML = '<span class="err">' + (e.message || e) + '</span>';
  }
});

$('#pasteDemoBtn').addEventListener('click', () => {
  $('#input').value =
    'old_ward_name\told_district_name\told_province_name\n' +
    'Phường 12\tQuận Gò Vấp\tThành phố Hồ Chí Minh\n' +
    'Phường 15\tQuận Gò Vấp\tThành phố Hồ Chí Minh';
});

$('#convertBtn').addEventListener('click', async () => {
  const out = $('#output');
  if (!db) { out.textContent = 'Chưa nạp SQL.'; return; }
  const { header, rows } = parseTable($('#input').value);
  const results = [];
  const outHeader = [
    'old_ward_name','old_district_name','old_province_name',
    'new_ward_name','new_province_name','direction',
  ];
  if (!$('#noHeader').checked) results.push(outHeader);
  let count = 0;
  for (const r of rows) {
    const mapped = await convertOne($('#mode').value, header, r);
    results.push([
      mapped.old_ward_name,
      mapped.old_district_name,
      mapped.old_province_name,
      mapped.new_ward_name,
      mapped.new_province_name,
      mapped.direction,
    ]);
    count++;
    if (count % 500 === 0) await sleep(0);
  }
  out.textContent = joinTSV(results);
  $('#rowCount').textContent = `${count} dòng`;
});

$('#copyBtn').addEventListener('click', async () => {
  const txt = $('#output').textContent || '';
  await navigator.clipboard.writeText(txt);
  alert('Đã copy TSV vào clipboard');
});

// --------- Auto-load local SQL if exists ---------
(async () => {
  try {
    const defaultUrl = './ward_mappings.sql';
    $('#sqlUrl').value = defaultUrl;
    await loadSQLfromURL(defaultUrl);
  } catch (e) {
    $('#sqlStatus').innerHTML = '<span class="muted">Không tìm thấy ward_mappings.sql tại root. Vui lòng nhập URL hoặc chọn file.</span>';
  }
})();
