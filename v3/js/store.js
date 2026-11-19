// データ層：記録・設定・下書き。記録の形は v2（スタンスメモ全版共通の dataVersion 2）のまま。
// 保存先は v3 専用（claude3:）。ほかの版のデータには書き込まない。

const P = 'claude3:';
export const KEYS = {
  records: `${P}records-v1`,
  settings: `${P}settings-v1`,
  draft: `${P}draft-v1`,
  snowFav: `${P}snow-fav-v1`,
};

// 同じ kanon6343.github.io の中にある、ほかの版の履歴（読むだけ）
export const OTHER_SOURCES = [
  { key: 'claude:snowboard-history-v1', label: 'Claude版（v2.5）' },
  { key: 'main:snowboard-history-v1', label: '正式版' },
  { key: 'haru-detail:snowboard-history-v1', label: 'はるくんの試作版' },
  { key: 'snowboard-history-v1', label: 'オリジナル版' },
];

export const SNOW = ['パウダー', '圧雪', '春雪', 'アイス'];
export const STANCE = ['ダック', '前振り', '後振り'];
export const DISK = ['前', '中', '後'];

export const CHOICES = {
  shape: { twin: 'ツイン', directionalTwin: 'ディレクショナルツイン', directional: 'ディレクショナル', other: 'その他' },
  nose: { round: 'ラウンド', hammer: 'ハンマーヘッド', semiHammer: 'セミハンマー', other: 'その他' },
  bend: { camber: 'キャンバー', rocker: 'ロッカー', flat: 'フラット', hybrid: 'ハイブリッド', other: 'その他' },
  diskType: { holes: '穴位置式', slots: '長穴スライド式', mixed: '穴と長穴の併用', other: 'その他・不明' },
  heelcupOrigin: { near: '手前から', far: '奥から' },
};

// ---------------------------------------------------------------- 正規化
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = v => {
  if (!['string', 'number'].includes(typeof v) || String(v).trim() === '') return '';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? String(n) : '';
};
const choice = (v, set) => (Object.hasOwn(set, v) ? v : '');
const axis = (v, dirs) => {
  const a = obj(v), mm = num(a.mm);
  return { direction: mm === '' ? '' : dirs.includes(a.direction) ? a.direction : '', mm };
};

export function normalizeDetail(value) {
  const v = obj(value), s = obj(v.setback), disk = obj(v.diskShift), heel = obj(v.heelcup);
  const setback = axis(s, ['nose', 'tail']);
  setback.basis = setback.mm === '' ? '' : ['reference', 'center'].includes(s.basis) ? s.basis : '';
  const foot = side => {
    const f = obj(disk[side]);
    return { type: choice(f.type, CHOICES.diskType), longitudinal: axis(f.longitudinal, ['nose', 'tail']), lateral: axis(f.lateral, ['toe', 'heel']) };
  };
  const cup = side => {
    const h = obj(heel[side]);
    return { inner: text(h.inner, 64), outer: text(h.outer, 64), origin: choice(h.origin, CHOICES.heelcupOrigin), recorded: h.recorded === true };
  };
  return {
    version: 1, shape: choice(v.shape, CHOICES.shape), nose: choice(v.nose, CHOICES.nose), bend: choice(v.bend, CHOICES.bend),
    boardNote: text(v.boardNote, 160), bindingName: text(v.bindingName, 128),
    forwardLeanLeft: text(v.forwardLeanLeft, 64), forwardLeanRight: text(v.forwardLeanRight, 64),
    setback, diskShift: { left: foot('left'), right: foot('right') }, heelcup: { left: cup('left'), right: cup('right') },
    note: text(v.note, 1000),
  };
}

export function hasDetail(d) {
  const n = normalizeDetail(d);
  return !!(n.shape || n.nose || n.bend || n.boardNote || n.bindingName || n.forwardLeanLeft || n.forwardLeanRight || n.setback.mm !== '' || n.note ||
    ['left', 'right'].some(s => n.diskShift[s].type || n.diskShift[s].longitudinal.mm !== '' || n.diskShift[s].lateral.mm !== '' || n.heelcup[s].inner || n.heelcup[s].outer));
}

const holeList = a => [...new Set((Array.isArray(a) ? a : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 12))].sort((x, y) => x - y);
const refIndex = v => (v === null || v === undefined || v === '' ? null : Number.isInteger(Number(v)) && v >= 0 && v < 6 ? Number(v) : null);
export const normalizeWidth = v => {
  if (typeof v !== 'number' && (typeof v !== 'string' || v.trim() === '')) return '';
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
};

export function newId() { return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`; }

export function normalizeRecord(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const r = { ...x };
  r.id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id).trim() || newId() : newId();
  r.favorite = !!r.favorite;
  if (Array.isArray(r.holes)) { // 古い形式：24個の true/false
    r.holes = { left: r.holes.slice(0, 12).flatMap((on, i) => (on ? [i] : [])), right: r.holes.slice(12, 24).flatMap((on, i) => (on ? [i] : [])) };
  }
  const h = obj(r.holes);
  r.holes = { left: holeList(h.left), right: holeList(h.right) };
  const ref = obj(r.reference);
  r.reference = { left: refIndex(ref.left), right: refIndex(ref.right) };
  const disk = obj(r.disk);
  r.disk = { left: DISK.includes(disk.left) ? disk.left : '', right: DISK.includes(disk.right) ? disk.right : '' };
  r.dataVersion = 2;
  r.dateTime = typeof r.dateTime === 'string' ? r.dateTime : '';
  r.board = String(r.board ?? '').trim();
  r.snow = String(r.snow ?? '');
  r.comment = String(r.comment ?? '');
  r.leftAngle = String(r.leftAngle ?? '').trim();
  r.rightAngle = String(r.rightAngle ?? '').trim();
  r.stance = String(r.stance ?? '');
  r.stanceWidth = normalizeWidth(r.stanceWidth);
  r.detail = normalizeDetail(r.detail);
  return r;
}

// ---------------------------------------------------------------- 記録の読み書き
export class StorageError extends Error {}

export function readRecords() {
  let raw;
  try { raw = localStorage.getItem(KEYS.records); } catch { throw new StorageError('この端末では保存領域を使えません。'); }
  let items;
  try { items = JSON.parse(raw ?? '[]'); } catch { throw new StorageError('保存した記録が壊れていて読めません。'); }
  if (!Array.isArray(items) || items.some(i => !i || typeof i !== 'object' || Array.isArray(i))) throw new StorageError('保存した記録の形がおかしく、読めません。');
  return { raw, items: items.map(normalizeRecord) };
}

// 読んだ時（raw）から別のタブで変わっていたら書かない
export function writeRecords(expectedRaw, items) {
  const now = localStorage.getItem(KEYS.records);
  if (now !== expectedRaw) return { ok: false, reason: 'changed' };
  try { localStorage.setItem(KEYS.records, JSON.stringify(items)); }
  catch { return { ok: false, reason: 'quota' }; }
  return { ok: true };
}

export function mutate(fn) {
  const snap = readRecords();
  const next = fn(snap.items.slice());
  if (!next) return { ok: false, reason: 'cancel' };
  return writeRecords(snap.raw, next);
}

// ---------------------------------------------------------------- 設定・下書き（壊れていても既定値で動く）
const DEFAULT_SETTINGS = { theme: 'auto', mode: 'simple', stanceDir: 'regular', historyView: 'list', sort: 'new', snowMode: 'balance', snowRegion: 'all', importedFrom: [] };
export function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...obj(JSON.parse(localStorage.getItem(KEYS.settings) || '{}')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try { localStorage.setItem(KEYS.settings, JSON.stringify(next)); } catch {}
  return next;
}
export function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function writeJSON(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

// ---------------------------------------------------------------- バックアップ（v2 と同じ形式で読み書きできる）
export function backupPayload(items) {
  return { app: 'snowboard-stance-memo', dataVersion: 2, exportedAt: new Date().toISOString(), env: 'claude-v3', items };
}

export function parseBackup(json) {
  const items = Array.isArray(json) ? json : json && Array.isArray(json.items) ? json.items : null;
  if (!items) return null;
  return items.map(normalizeRecord).filter(Boolean);
}

const dateKey = r => { const t = Date.parse(r.dateTime); return Number.isFinite(t) ? t : null; };

// 取り込みの計画：同じ ID・同じ日時の記録は足さない
export function planImport(existing, incoming) {
  const ids = new Set(existing.map(r => r.id));
  const times = new Set(existing.map(dateKey).filter(t => t !== null));
  const add = [], skipped = [];
  for (const r of incoming) {
    const t = dateKey(r);
    if (ids.has(r.id) || (t !== null && times.has(t))) { skipped.push(r); continue; }
    ids.add(r.id); if (t !== null) times.add(t);
    add.push(r);
  }
  return { add, skipped };
}

export function readOtherSource(key) {
  let raw;
  try { raw = localStorage.getItem(key); } catch { return null; }
  if (raw === null) return null;
  try { return parseBackup(JSON.parse(raw)); } catch { return null; }
}

export const sortByDate = items => items.slice().sort((a, b) => (dateKey(b) ?? 0) - (dateKey(a) ?? 0));
