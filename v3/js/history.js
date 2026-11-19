// 履歴の画面：検索・絞り込み・並べ替え、一覧／板ごと、詳細、お気に入り、編集、削除、統計
import { h, $, $$, toast, ask, sheet, segmented, fmtDate, signed, download } from './ui.js';
import { miniBoard } from './binding.js';
import * as S from './store.js';

const DETAIL_LABEL = { nose: 'ノーズ側', tail: 'テール側', toe: 'つま先側', heel: 'かかと側' };

export function detailRows(detail) {
  const d = S.normalizeDetail(detail), rows = [];
  for (const [k, label] of [['shape', 'シェイプ'], ['nose', 'ノーズ'], ['bend', 'ベンド']]) if (d[k]) rows.push([label, S.CHOICES[k][d[k]]]);
  if (d.boardNote) rows.push(['形状の補足', d.boardNote]);
  if (d.bindingName) rows.push(['ビンディング', d.bindingName]);
  if (d.forwardLeanLeft || d.forwardLeanRight) rows.push(['フォワードリーン', `左 ${d.forwardLeanLeft || '—'} / 右 ${d.forwardLeanRight || '—'}`]);
  if (d.setback.mm !== '') rows.push(['セットバック', `${{ reference: '推奨位置', center: '板の中心' }[d.setback.basis] || '基準なし'}から ${DETAIL_LABEL[d.setback.direction] || ''} ${d.setback.mm}mm`]);
  for (const [side, label] of [['left', '左'], ['right', '右']]) {
    const ds = d.diskShift[side], hc = d.heelcup[side];
    if (ds.type) rows.push([`${label} ディスク方式`, S.CHOICES.diskType[ds.type]]);
    if (ds.longitudinal.mm !== '') rows.push([`${label} 前後のずらし`, `${DETAIL_LABEL[ds.longitudinal.direction] || ''} ${ds.longitudinal.mm}mm`]);
    if (ds.lateral.mm !== '') rows.push([`${label} 横のずらし`, `${DETAIL_LABEL[ds.lateral.direction] || ''} ${ds.lateral.mm}mm`]);
    if (hc.inner || hc.outer) rows.push([`${label} ヒールカップ`, `${hc.origin ? S.CHOICES.heelcupOrigin[hc.origin] + ' ' : ''}内 ${hc.inner || '—'} / 外 ${hc.outer || '—'}`]);
  }
  if (d.note) rows.push(['ギア調整メモ', d.note]);
  return rows;
}

const blankFilter = () => ({ q: '', snow: '', stance: '', fav: false, la: '', ra: '', tol: '2' });

export function createHistoryView(app) {
  const root = h('section.view', { id: 'view-history', 'aria-labelledby': 'historyTitle' });
  let items = [], raw = null, error = null;
  let filter = blankFilter();
  let focusId = null;

  const search = h('input.search', { type: 'search', placeholder: '板名・メモで探す', 'aria-label': '板名・メモで探す', oninput: () => { filter.q = search.value; render(); } });
  const sortSel = h('select', { 'aria-label': '並べ替え', onchange: () => { app.setSetting({ sort: sortSel.value }); render(); } },
    [['new', '新しい順'], ['old', '古い順'], ['board', '板名順'], ['snow', '雪質順']].map(([v, t]) => h('option', { value: v }, t)));
  const viewSeg = segmented([['list', '一覧'], ['board', '板ごと']], app.settings.historyView, v => { app.setSetting({ historyView: v }); render(); }, { allowEmpty: false, label: '表示' });
  const filterBtn = h('button.btn.small', { type: 'button', onclick: openFilter }, '絞り込み');
  const statsBtn = h('button.btn.small.ghost', { type: 'button', onclick: openStats }, '統計');
  const chips = h('div.active-filters');
  const count = h('p.count', { 'aria-live': 'polite' });
  const list = h('div.records');
  const errorBox = h('div.banner.error', { hidden: true });

  root.append(
    h('header.view-head', h('h1', { id: 'historyTitle' }, '履歴'), viewSeg),
    errorBox,
    h('div.toolbar', search, h('div.toolbar-row', filterBtn, sortSel, statsBtn)),
    chips, count, list);

  function load() {
    try { const s = S.readRecords(); items = s.items; raw = s.raw; error = null; }
    catch (e) { items = []; raw = null; error = e.message; }
    app.record.refreshBoards(S.sortByDate(items));
  }

  function matches(r) {
    const q = filter.q.trim().toLowerCase();
    if (q && ![r.board, r.comment, r.detail.note, r.detail.bindingName].some(t => (t || '').toLowerCase().includes(q))) return false;
    if (filter.snow && r.snow !== filter.snow) return false;
    if (filter.stance && r.stance !== filter.stance) return false;
    if (filter.fav && !r.favorite) return false;
    const tol = Math.max(0, Number(filter.tol) || 0);
    for (const [f, key] of [['la', 'leftAngle'], ['ra', 'rightAngle']]) {
      if (filter[f] === '') continue;
      const v = Number(r[key]);
      if (r[key] === '' || !Number.isFinite(v) || Math.abs(v - Number(filter[f])) > tol) return false;
    }
    return true;
  }
  function sorted(arr) {
    const s = app.settings.sort;
    const byDate = S.sortByDate(arr);
    if (s === 'old') return byDate.reverse();
    if (s === 'board') return byDate.sort((a, b) => (a.board || '￿').localeCompare(b.board || '￿', 'ja'));
    if (s === 'snow') return byDate.sort((a, b) => (S.SNOW.indexOf(a.snow) + 1 || 99) - (S.SNOW.indexOf(b.snow) + 1 || 99));
    return byDate;
  }

  function render() {
    sortSel.value = app.settings.sort;
    viewSeg.set(app.settings.historyView);
    errorBox.hidden = !error;
    errorBox.replaceChildren(...(error ? [h('p', error + ' 消さずに残しています。'), h('button.btn.small', { type: 'button', onclick: exportRaw }, '元のデータを書き出す')] : []));
    renderChips();
    const shown = sorted(items.filter(matches));
    count.textContent = items.length ? `${shown.length}件${shown.length !== items.length ? ` / 全${items.length}件` : ''}` : '';
    if (!items.length) {
      list.replaceChildren(error ? '' : h('div.empty', h('p.empty-title', 'まだ記録がありません'), h('p', '「記録する」で最初の一本を保存しましょう。'),
        h('button.btn.primary', { type: 'button', onclick: () => app.go('record') }, '記録する')));
      return;
    }
    if (!shown.length) { list.replaceChildren(h('div.empty', h('p', '条件に合う記録がありません。'), h('button.btn.small', { type: 'button', onclick: () => { filter = blankFilter(); search.value = ''; render(); } }, '絞り込みを解除'))); return; }
    list.replaceChildren(...(app.settings.historyView === 'board' ? byBoard(shown) : shown.map(card)));
    if (focusId) {
      const el = list.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
      focusId = null;
      if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'center' }); setTimeout(() => el.classList.remove('flash'), 1600); }
    }
  }

  function renderChips() {
    const on = [];
    const clear = key => () => { filter[key] = blankFilter()[key]; render(); };
    if (filter.snow) on.push([filter.snow, clear('snow')]);
    if (filter.stance) on.push([S.stanceLabel(filter.stance), clear('stance')]);
    if (filter.fav) on.push(['★のみ', clear('fav')]);
    if (filter.la !== '' || filter.ra !== '') on.push([`角度 ${filter.la || '—'}° / ${filter.ra || '—'}° ±${filter.tol}`, () => { filter.la = filter.ra = ''; render(); }]);
    chips.replaceChildren(...on.map(([t, fn]) => h('button.chip', { type: 'button', onclick: fn, 'aria-label': `${t} を外す` }, t, ' ×')));
    filterBtn.textContent = on.length ? `絞り込み（${on.length}）` : '絞り込み';
  }

  function card(r) {
    const dir = app.settings.stanceDir;
    const angles = h('p.angles', h('span', h('small', '左'), signed(r.leftAngle)), h('span', h('small', '右'), signed(r.rightAngle)));
    const meta = [r.snow, S.stanceLabel(r.stance), r.stanceWidth ? `幅 ${r.stanceWidth}cm` : '', r.disk.left || r.disk.right ? `ディスク ${r.disk.left || '—'}/${r.disk.right || '—'}` : ''].filter(Boolean);
    return h('article.record', { dataset: { id: r.id } },
      h('button.record-main', { type: 'button', onclick: () => openDetail(r.id), 'aria-label': `${r.board || '板名なし'} ${fmtDate(r.dateTime)} の詳細` },
        h('div.record-top', h('span.date', fmtDate(r.dateTime)), r.favorite ? h('span.star', { 'aria-label': 'お気に入り' }, '★') : null, S.hasDetail(r.detail) ? h('span.tag', '詳細') : null),
        h('h3', r.board || '板名なし'),
        h('div.record-mid', angles, miniBoard(r, dir)),
        meta.length ? h('p.meta', meta.join(' · ')) : null,
        r.comment ? h('p.memo', r.comment) : null));
  }

  function byBoard(arr) {
    const groups = new Map();
    for (const r of arr) { const k = r.board || '板名なし'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    return [...groups].map(([name, rs]) => {
      const top = mode(rs.map(r => `${signed(r.leftAngle)} / ${signed(r.rightAngle)}`).filter(s => s !== '— / —'));
      return h('details.board-group', { open: groups.size <= 3 },
        h('summary', h('span.bg-name', name), h('span.bg-count', `${rs.length}件`), top ? h('span.bg-top', `よく使う角度 ${top}`) : null),
        h('div.board-group-list', rs.map(card)));
    });
  }
  const mode = arr => { const c = new Map(); arr.forEach(v => c.set(v, (c.get(v) || 0) + 1)); return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] || ''; };

  function find(id) { load(); return items.find(r => r.id === id); }

  function openDetail(id) {
    const r = find(id);
    if (!r) { toast('この記録が見つかりません。', 'error'); render(); return; }
    const rows = [
      ['日時', fmtDate(r.dateTime)], ['雪質', r.snow || '—'], ['スタンス', [S.stanceLabel(r.stance), r.stanceWidth ? `幅 ${r.stanceWidth}cm` : ''].filter(Boolean).join(' · ') || '—'],
      ['角度', `左 ${signed(r.leftAngle)} / 右 ${signed(r.rightAngle)}`], ['ディスク', `左 ${r.disk.left || '—'} / 右 ${r.disk.right || '—'}`],
      ['ビス穴', `左 ${r.holes.left.length}個 / 右 ${r.holes.right.length}個`],
      ...detailRows(r.detail),
    ];
    const body = h('div.detail',
      h('div.detail-board', miniBoard(r, app.settings.stanceDir)),
      h('dl.rows', rows.map(([k, v]) => h('div', h('dt', k), h('dd', v)))),
      r.comment ? h('div.memo-block', h('h3', '感想'), h('p', r.comment)) : null);
    const dlg = sheet(r.board || '板名なし', body, { actions: [
      h('button.btn.ghost.danger-text', { type: 'button', onclick: () => remove(r, dlg) }, '削除'),
      h('button.btn.ghost', { type: 'button', onclick: () => toggleFav(r, dlg) }, r.favorite ? '★を外す' : '★をつける'),
      h('button.btn.ghost', { type: 'button', onclick: () => edit(r, dlg) }, '編集'),
      h('button.btn.primary', { type: 'button', onclick: () => { dlg.close(); use(r); } }, 'この設定を使う'),
    ] });
  }

  async function guardInput(message) {
    if (!app.record.hasInput()) return true;
    return ask('入力中の内容', message, { ok: '置きかえる', danger: true });
  }
  async function use(r) {
    if (!(await guardInput('記録する画面に入力中の内容があります。この記録の設定で置きかえますか？'))) return;
    app.record.load(r); app.go('record'); toast('設定を読み込みました。感想は空にしてあります。');
  }
  async function edit(r, dlg) {
    if (r.favorite && !(await ask('★の記録を編集', 'お気に入りの記録を編集します。よろしいですか？', { ok: '編集する' }))) return;
    if (!(await guardInput('記録する画面に入力中の内容があります。編集する記録で置きかえますか？'))) return;
    dlg.close(); app.record.load(r, { edit: true }); app.go('record');
  }
  function toggleFav(r, dlg) {
    let res;
    try { res = S.mutate(list => list.map(x => (x.id === r.id ? { ...x, favorite: !x.favorite } : x))); } catch (e) { toast(e.message, 'error'); return; }
    if (!res.ok) { toast('別の画面で記録が変わりました。もう一度やってください。', 'error'); return; }
    dlg.close(); load(); render(); openDetail(r.id);
  }
  async function remove(r, dlg) {
    if (r.favorite) { toast('★の記録は削除できません。先に★を外してください。', 'error'); return; }
    if (!(await ask('記録を削除', `${r.board || '板名なし'}（${fmtDate(r.dateTime)}）を削除します。元に戻せません。`, { ok: '削除する', danger: true }))) return;
    let res;
    try { res = S.mutate(list => { const i = list.findIndex(x => x.id === r.id); if (i < 0 || JSON.stringify(list[i]) !== JSON.stringify(r)) return null; list.splice(i, 1); return list; }); }
    catch (e) { toast(e.message, 'error'); return; }
    if (!res.ok) { toast(res.reason === 'cancel' ? '別の画面でこの記録が変わりました。削除していません。' : '削除できませんでした。', 'error'); return; }
    dlg.close(); load(); render(); toast('削除しました');
  }

  function openFilter() {
    const draft = { ...filter };
    const num = (key, label, attrs = {}) => h('label.field', h('span.field-label', label), h('input', { type: 'number', inputmode: 'decimal', value: draft[key], ...attrs, oninput: e => (draft[key] = e.target.value.trim()) }));
    const body = h('div.filter-form',
      h('div.field', h('span.field-label', '雪質'), segmented(S.SNOW.map(s => [s, s]), draft.snow, v => (draft.snow = v))),
      h('div.field', h('span.field-label', 'スタンス'), segmented(S.STANCE, draft.stance, v => (draft.stance = v))),
      h('label.check', h('input', { type: 'checkbox', checked: draft.fav, onchange: e => (draft.fav = e.target.checked) }), ' ★の記録だけ'),
      h('fieldset.angles-filter', h('legend', '角度が近い記録'), h('div.grid3', num('la', '左足', { placeholder: '15' }), num('ra', '右足', { placeholder: '-9' }), num('tol', '±', { min: '0', step: '1' }))));
    const dlg = sheet('絞り込み', body, { actions: [
      h('button.btn.ghost', { type: 'button', onclick: () => { filter = { ...blankFilter(), q: filter.q }; dlg.close(); render(); } }, 'すべて解除'),
      h('button.btn.primary', { type: 'button', onclick: () => { filter = draft; dlg.close(); render(); } }, 'この条件で見る'),
    ] });
  }

  function openStats() {
    load();
    if (!items.length) { toast('まだ記録がありません。'); return; }
    const boards = new Map();
    for (const r of items) { const k = r.board || '板名なし'; if (!boards.has(k)) boards.set(k, []); boards.get(k).push(r); }
    const widths = items.map(r => Number(r.stanceWidth)).filter(n => n > 0);
    const body = h('div.stats',
      h('div.stat-tiles',
        h('div.tile', h('strong', items.length), h('span', '記録')),
        h('div.tile', h('strong', [...boards.keys()].filter(k => k !== '板名なし').length), h('span', '板')),
        h('div.tile', h('strong', items.filter(r => r.favorite).length), h('span', '★')),
        h('div.tile', h('strong', widths.length ? `${(widths.reduce((a, b) => a + b, 0) / widths.length).toFixed(1)}` : '—'), h('span', '平均の幅 cm'))),
      h('h3', '板ごと'),
      h('table.stat-table', h('thead', h('tr', h('th', '板'), h('th', '件数'), h('th', 'よく使う角度'), h('th', '雪質'))),
        h('tbody', [...boards].sort((a, b) => b[1].length - a[1].length).map(([name, rs]) => h('tr',
          h('td', name), h('td', rs.length),
          h('td', mode(rs.map(r => `${signed(r.leftAngle)} / ${signed(r.rightAngle)}`).filter(s => s !== '— / —')) || '—'),
          h('td', mode(rs.map(r => r.snow).filter(Boolean)) || '—'))))),
      h('p.hint', '絞り込みに関係なく、すべての記録を数えています。'));
    sheet('記録の統計', body, { wide: true });
  }

  function exportRaw() {
    let rawText = null; try { rawText = localStorage.getItem(S.KEYS.records); } catch {}
    if (rawText === null) { toast('書き出す元のデータがありません。'); return; }
    download(`stance-memo-v3_raw_${Date.now()}.txt`, rawText, 'text/plain');
  }

  return {
    el: root,
    show(opts = {}) { if (opts.focus) focusId = opts.focus; load(); render(); },
    refresh() { load(); render(); },
    items: () => items,
  };
}
