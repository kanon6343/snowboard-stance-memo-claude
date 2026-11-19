// 記録する画面（簡易／詳細）。下書きは自動で残す。
import { h, $, $$, toast, ask, sheet, segmented } from './ui.js';
import { bindingBoard, footMount } from './binding.js';
import * as S from './store.js';

const blank = () => ({
  board: '', snow: '', stance: '', stanceWidth: '', leftAngle: '', rightAngle: '',
  disk: { left: '', right: '' }, holes: { left: [], right: [] }, reference: { left: null, right: null },
  comment: '', detail: S.normalizeDetail({}),
});

export function createRecordView(app) {
  let st = blank();
  let editing = null;      // { id, original }
  let draftTimer = null;
  const root = h('section.view', { id: 'view-record', 'aria-labelledby': 'recordTitle' });

  const restored = S.readJSON(S.KEYS.draft, null);
  if (restored && restored.state) {
    st = { ...blank(), ...restored.state, detail: S.normalizeDetail(restored.state.detail) };
    st.stance = S.stanceCode(st.stance);   // 古い下書きの日本語の値も直す
    editing = restored.editing || null;
  }

  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => S.writeJSON(S.KEYS.draft, isEmpty() && !editing ? null : { state: st, editing, at: Date.now() }), 250);
  }
  const isEmpty = () => JSON.stringify({ ...st, detail: S.normalizeDetail(st.detail) }) === JSON.stringify(blank());
  let quick = null;
  const changed = () => { saveDraft(); renderSummary(); quick?.refresh(); };

  // ---- 部品
  const field = (label, control, hint) => h('label.field', h('span.field-label', label), control, hint ? h('small.hint', hint) : null);
  const input = (get, set, attrs = {}) => {
    const el = h('input', { ...attrs, value: get() ?? '', oninput: () => { set(el.value); changed(); } });
    el.sync = () => { if (document.activeElement !== el) el.value = get() ?? ''; };
    return el;
  };
  const select = (options, get, set, attrs = {}) => {
    const el = h('select', { ...attrs, onchange: () => { set(el.value); changed(); } }, h('option', { value: '' }, '未設定'), Object.entries(options).map(([v, t]) => h('option', { value: v }, t)));
    el.sync = () => { el.value = get() || ''; };
    return el;
  };
  const syncers = [];
  const track = el => (syncers.push(el), el);
  const detailOnly = el => { el.classList.add('detail-only'); return el; };

  function stepper(side) {
    const key = side === 'left' ? 'leftAngle' : 'rightAngle';
    const el = track(input(() => st[key], v => { st[key] = v.trim(); board.paint(); }, { type: 'number', inputmode: 'decimal', step: '1', min: '-60', max: '60', placeholder: side === 'left' ? '15' : '-9', 'aria-label': `${side === 'left' ? '左足' : '右足'}の角度` }));
    const bump = d => { const n = Number(st[key] || 0) + d; st[key] = String(Math.max(-60, Math.min(60, n))); el.value = st[key]; board.paint(); changed(); };
    return h('div.stepper', h('button.step', { type: 'button', 'aria-label': '1度へらす', onclick: () => bump(-1) }, '−'), el, h('button.step', { type: 'button', 'aria-label': '1度ふやす', onclick: () => bump(1) }, '+'));
  }

  // ---- 見出し
  const modeSwitch = segmented([['simple', '簡易'], ['detail', '詳細']], app.settings.mode, v => { app.setSetting({ mode: v }); applyMode(); }, { allowEmpty: false, label: '入力の細かさ' });
  const editBanner = h('div.banner.edit', { hidden: true }, h('span.edit-text'), h('button.btn.small.ghost', { type: 'button', onclick: () => cancelEdit() }, '編集をやめる'));
  const summary = h('p.record-summary', { 'aria-live': 'polite' });

  // ---- 板と雪
  const boards = h('datalist', { id: 'boardNames' });
  const boardInput = track(input(() => st.board, v => (st.board = v), { type: 'text', list: 'boardNames', maxlength: '80', placeholder: '例：CAPiTA DOA 154', autocomplete: 'off' }));
  const snowSeg = segmented(S.SNOW.map(s => [s, s]), st.snow, v => { st.snow = v; changed(); }, { label: '雪質' });
  const useShape = detailOnly(h('button.btn.small.ghost', { type: 'button', onclick: copyShapeFromHistory }, 'この板の前回の形状を使う'));
  const cardBoard = h('section.card', h('h2', '板と雪'), field('板', boardInput), boards, h('div.field', h('span.field-label', '雪質'), snowSeg), useShape);

  // ---- 板の形状（詳細）
  const d = () => st.detail;
  const cardShape = detailOnly(h('section.card', h('h2', '板の形状'),
    h('div.grid3',
      field('シェイプ', track(select(S.CHOICES.shape, () => d().shape, v => (d().shape = v)))),
      field('ノーズ', track(select(S.CHOICES.nose, () => d().nose, v => (d().nose = v)))),
      field('ベンド', track(select(S.CHOICES.bend, () => d().bend, v => (d().bend = v))))),
    field('形状の補足', track(input(() => d().boardNote, v => (d().boardNote = v), { type: 'text', maxlength: '160', placeholder: '例：ボリュームシフト、サイドカット' }))),
    h('button.btn.small.ghost', { type: 'button', onclick: applyShapeToHistory }, '同じ板の記録すべてに、この形状を反映…')));

  // ---- スタンス
  const stanceSeg = segmented(S.STANCE, st.stance, v => { st.stance = v; changed(); }, { label: 'スタンス' });
  const widthInput = track(input(() => st.stanceWidth, v => (st.stanceWidth = v.trim()), { type: 'number', inputmode: 'decimal', min: '0', step: '0.5', placeholder: '53' }));
  const dirSeg = segmented([['regular', 'レギュラー'], ['goofy', 'グーフィー']], app.settings.stanceDir, v => { app.setSetting({ stanceDir: v }); applyDir(); }, { allowEmpty: false, label: '前足' });
  const cardStance = h('section.card', h('h2', 'スタンス'),
    h('div.field', h('span.field-label', '前足'), dirSeg, h('small.hint', 'レギュラーは左足が前、グーフィーは右足が前。ビス穴の図の向きだけが変わります（角度の欄はいつも左・右の順）。')),
    h('div.field', h('span.field-label', '向き'), stanceSeg),
    h('label.field.inline', h('span.field-label', '幅'), widthInput, h('span.unit', 'cm')));

  // ---- 角度とディスク（左右を並べる）
  const footCol = side => {
    const diskSeg = segmented(S.DISK.map(v => [v, v]), st.disk[side], v => { st.disk[side] = v; changed(); }, { label: `${side === 'left' ? '左' : '右'}足のディスク` });
    diskSeg.classList.add('compact');
    syncers.push({ sync: () => diskSeg.set(st.disk[side]) });
    const leanKey = side === 'left' ? 'forwardLeanLeft' : 'forwardLeanRight';
    return h('div.foot-col', h('h3', side === 'left' ? '左足の角度' : '右足の角度', h('small', '（°）')), stepper(side),
      h('div.field', h('span.field-label', 'ディスク'), diskSeg),
      detailOnly(field('フォワードリーン', track(input(() => d()[leanKey], v => (d()[leanKey] = v), { type: 'text', maxlength: '64', placeholder: '例：F2' })))));
  };
  const feetCols = { left: footCol('left'), right: footCol('right') };
  const feetBox = h('div.feet');
  const cardFeet = h('section.card', h('h2', '角度とディスク'), feetBox);

  // ---- セットバック（詳細）
  const sb = () => d().setback;
  const sbDir = segmented([['nose', 'ノーズ側'], ['tail', 'テール側']], sb().direction, v => { sb().direction = v; changed(); }, { label: 'ずらす向き' });
  syncers.push({ sync: () => sbDir.set(sb().direction) });
  const cardSetback = detailOnly(h('section.card', h('h2', 'セットバック'),
    h('div.grid2',
      field('基準', track(select({ reference: '推奨位置から', center: '板の中心から' }, () => sb().basis, v => (sb().basis = v)))),
      h('label.field', h('span.field-label', 'ずらした量'), h('span.with-unit', track(input(() => sb().mm, v => (sb().mm = v.trim()), { type: 'number', inputmode: 'decimal', min: '0', step: '1', placeholder: '20' })), h('span.unit', 'mm')))),
    h('div.field', h('span.field-label', '向き'), sbDir)));

  // ---- ビス穴
  const board = bindingBoard(st, changed, () => app.settings.stanceDir);
  const cardHoles = h('section.card', h('h2', 'ビス穴と推奨位置'), h('p.hint', '使っている穴を押します。真ん中の細い枠は、板の推奨位置（目印）です。'), board);

  // ---- ディスクとヒールカップ（詳細）
  const gearCol = side => {
    const ds = () => d().diskShift[side], hc = () => d().heelcup[side];
    const lonDir = segmented([['nose', 'ノーズ側'], ['tail', 'テール側']], ds().longitudinal.direction, v => { ds().longitudinal.direction = v; changed(); }, { label: '前後の向き' });
    const latDir = segmented([['toe', 'つま先側'], ['heel', 'かかと側']], ds().lateral.direction, v => { ds().lateral.direction = v; changed(); }, { label: '横の向き' });
    syncers.push({ sync: () => { lonDir.set(ds().longitudinal.direction); latDir.set(ds().lateral.direction); } });
    const mm = (get, set) => h('span.with-unit', track(input(get, set, { type: 'number', inputmode: 'decimal', min: '0', step: '1', placeholder: '0' })), h('span.unit', 'mm'));
    return h('div.gear-col', h('h3', side === 'left' ? '左足' : '右足'),
      field('ディスクの方式', track(select(S.CHOICES.diskType, () => ds().type, v => (ds().type = v)))),
      h('div.field', h('span.field-label', '前後のずらし'), mm(() => ds().longitudinal.mm, v => (ds().longitudinal.mm = v.trim())), lonDir),
      h('div.field', h('span.field-label', '横のずらし'), mm(() => ds().lateral.mm, v => (ds().lateral.mm = v.trim())), latDir),
      field('ヒールカップ（目盛りの数え方）', track(select(S.CHOICES.heelcupOrigin, () => hc().origin, v => (hc().origin = v)))),
      h('div.grid2',
        field('内側', track(input(() => hc().inner, v => (hc().inner = v), { type: 'text', maxlength: '64', placeholder: '例：3' }))),
        field('外側', track(input(() => hc().outer, v => (hc().outer = v), { type: 'text', maxlength: '64', placeholder: '例：3' })))));
  };
  const gearCols = { left: gearCol('left'), right: gearCol('right') };
  const gearBox = h('div.feet');
  const cardGear = detailOnly(h('section.card', h('h2', 'ビンディングの細かい調整'),
    field('ビンディング', track(input(() => d().bindingName, v => (d().bindingName = v), { type: 'text', maxlength: '128', placeholder: '例：Union Force' }))),
    gearBox));

  // ---- メモ
  const comment = h('textarea', { rows: 3, maxlength: '2000', placeholder: '滑った感じ、気づいたこと', oninput: () => { st.comment = comment.value; changed(); } });
  const note = h('textarea', { rows: 3, maxlength: '1000', placeholder: 'ギアの調整、次に試すこと', oninput: () => { d().note = note.value; changed(); } });
  syncers.push({ sync: () => { comment.value = st.comment; note.value = d().note; } });
  const cardMemo = h('section.card', h('h2', 'メモ'), h('label.field', h('span.field-label', '感想'), comment), detailOnly(h('label.field', h('span.field-label', 'ギア調整メモ'), note)));

  // ---- 保存の帯
  const clearBtn = h('button.btn.ghost', { type: 'button', onclick: clearAll }, 'クリア');
  const saveBtn = h('button.btn.primary.grow', { type: 'button', onclick: save }, 'この設定を保存');
  const bar = h('div.action-bar', clearBtn, saveBtn);

  // ---- 簡易入力：1 画面にまとめる。左右の足を並べ、ビス穴は縦 2 列（上＝ノーズ側）。感想はボタンから
  quick = (() => {
    const qBoard = track(input(() => st.board, v => (st.board = v), { type: 'text', list: 'boardNames', maxlength: '80', placeholder: '板の名前', autocomplete: 'off', 'aria-label': '板' }));
    const qSnow = segmented(S.SNOW.map(s => [s, s]), st.snow, v => { st.snow = v; changed(); }, { label: '雪質' });
    const qStance = segmented(S.STANCE, st.stance, v => { st.stance = v; changed(); }, { label: 'スタンス' });
    const qWidth = track(input(() => st.stanceWidth, v => (st.stanceWidth = v.trim()), { type: 'number', inputmode: 'decimal', min: '0', step: '0.5', placeholder: '幅', 'aria-label': 'スタンス幅（cm）' }));
    const disks = {}, mounts = {}, heads = {};
    const col = s => {
      disks[s] = segmented(S.DISK.map(v => [v, v]), st.disk[s], v => { st.disk[s] = v; changed(); }, { label: `${s === 'left' ? '左' : '右'}足のディスク` });
      disks[s].classList.add('compact');
      mounts[s] = footMount(st, s, () => app.settings.stanceDir, changed);
      heads[s] = h('div.qcol-head', h('strong', s === 'left' ? '左足' : '右足', h('small')), disks[s]);
      return h('div.qcol', heads[s], stepper(s), mounts[s]);
    };
    const memoBtn = h('button.btn.ghost.memo-btn', { type: 'button', onclick: openMemo });
    syncers.push({ sync: () => { qSnow.set(st.snow); qStance.set(st.stance); disks.left.set(st.disk.left); disks.right.set(st.disk.right); render(); } });
    function render() {
      paintEnds();
      const front = app.settings.stanceDir === 'goofy' ? 'right' : 'left';
      for (const s of ['left', 'right']) { heads[s].querySelector('small').textContent = s === front ? '前' : '後'; mounts[s].paint(); }
      memoBtn.textContent = st.comment.trim() ? `感想 ✓` : '感想';
      memoBtn.setAttribute('aria-label', st.comment.trim() ? `感想（入力済み）：${st.comment.trim().slice(0, 40)}` : '感想を書く');
    }
    function openMemo() {
      const ta = h('textarea', { rows: 5, maxlength: '2000', placeholder: '滑った感じ、気づいたこと', value: st.comment, oninput: () => { st.comment = ta.value; changed(); } });
      const dlg = sheet('感想', ta, { actions: [h('button.btn.primary', { type: 'button', onclick: () => dlg.close() }, '完了')] });
      setTimeout(() => ta.focus(), 50);
    }
    const toDetail = h('button.btn.small.ghost.to-detail', { type: 'button', 'aria-label': '詳細入力に切り替える', onclick: () => { app.setSetting({ mode: 'detail' }); applyMode(); } }, '詳細');
    const ends = h('div.qends');
    const el = h('div.quick',
      h('div.quick-row', qBoard, h('span.with-unit', qWidth, h('span.unit', 'cm')), toDetail),
      qSnow, qStance,
      h('div.quick-feet', ends, h('div.qcols', col('left'), col('right')), h('div.qends', h('span', '▼ テール側'))));
    // 上の帯：左右それぞれの列の上に「かかと ▲ノーズ つま先」（グーフィーは鏡の形）
    function paintEnds() {
      const g = app.settings.stanceDir === 'goofy';
      const one = () => h('div', h('span', g ? '◀つま先' : 'かかと'), h('b', '▲ノーズ'), h('span', g ? 'かかと' : 'つま先▶'));
      ends.replaceChildren(one(), one());
    }
    render();
    return { el, refresh: render, memoBtn };
  })();
  bar.prepend(quick.memoBtn);

  root.append(
    h('header.view-head', h('h1', { id: 'recordTitle' }, '記録する'), modeSwitch),
    editBanner, summary, quick.el,
    cardBoard, cardShape, cardStance, cardFeet, cardSetback, cardHoles, cardGear, cardMemo, bar);
  // 詳細入力の時だけ、カードの並びで全部を見せる
  for (const c of [cardBoard, cardStance, cardFeet, cardHoles, cardMemo]) c.classList.add('detail-only');

  // ---- 表示の更新
  // 簡易と詳細は別の入力欄を持つので、切り替えたら全部の欄を今の値に揃える（見えている値と保存する値をずらさない）
  function applyMode() {
    root.dataset.mode = app.settings.mode;
    modeSwitch.set(app.settings.mode);
    syncAll();
  }
  // 角度・調整の欄は、スタンスに関係なくいつも「左足・右足」の順（入力する場所が変わらないように）。図だけ前足に合わせる
  function applyDir() {
    dirSeg.set(app.settings.stanceDir);
    if (!feetBox.childElementCount) { feetBox.append(feetCols.left, feetCols.right); gearBox.append(gearCols.left, gearCols.right); }
    board.paint();
    quick?.refresh();   // 簡易入力の図（前足・つま先の向き）も描き直す
  }
  function syncAll() {
    syncers.forEach(s => s.sync());
    snowSeg.set(st.snow); stanceSeg.set(st.stance);
    board.paint();
    editBanner.hidden = !editing;
    if (editing) editBanner.querySelector('.edit-text').textContent = `編集中：${editing.label}`;
    saveBtn.textContent = editing ? '変更を保存' : 'この設定を保存';
    clearBtn.textContent = editing ? 'もとに戻す' : 'クリア';
    renderSummary();
  }
  function renderSummary() {
    const parts = [st.board || '板名なし', st.snow, (st.leftAngle || st.rightAngle) ? `${st.leftAngle || '—'}° / ${st.rightAngle || '—'}°` : '', st.stanceWidth ? `${st.stanceWidth}cm` : ''].filter(Boolean);
    summary.textContent = parts.join(' · ');
  }
  function refreshBoards(items) {
    boards.replaceChildren(...[...new Set(items.map(r => r.board).filter(Boolean))].slice(0, 50).map(b => h('option', { value: b })));
  }

  // ---- 操作
  function toRecord() {
    const width = S.normalizeWidth(st.stanceWidth);
    return {
      board: st.board.trim(), snow: st.snow, comment: st.comment.trim(), stance: st.stance, stanceWidth: width,
      leftAngle: String(st.leftAngle).trim(), rightAngle: String(st.rightAngle).trim(),
      disk: { ...st.disk }, holes: { left: [...st.holes.left], right: [...st.holes.right] }, reference: { ...st.reference },
      detail: S.normalizeDetail(st.detail), dataVersion: 2,
    };
  }
  async function save() {
    if (st.stanceWidth !== '' && S.normalizeWidth(st.stanceWidth) === '') { toast('スタンス幅は 0 より大きい数で入れてください（cm）。', 'error'); widthInput.focus(); return; }
    for (const [k, label] of [['leftAngle', '左足'], ['rightAngle', '右足']]) {
      if (st[k] !== '' && !Number.isFinite(Number(st[k]))) { toast(`${label}の角度を数で入れてください。`, 'error'); return; }
      if (st[k] !== '' && Math.abs(Number(st[k])) > 60) { toast(`${label}の角度は −60〜+60° で入れてください。`, 'error'); return; }
    }
    const rec = toRecord();
    let res;
    try {
      if (editing) {
        res = S.mutate(items => {
          const i = items.findIndex(r => r.id === editing.id);
          if (i < 0 || JSON.stringify(items[i]) !== editing.original) return null;
          items[i] = { ...items[i], ...rec };
          return items;
        });
        if (res.reason === 'cancel') { toast('別の画面でこの記録が変わったか、消されています。履歴から開き直してください。', 'error'); return; }
      } else {
        rec.id = S.newId(); rec.favorite = false; rec.dateTime = new Date().toISOString();
        res = S.mutate(items => [rec, ...items]);
      }
    } catch (e) { toast(e.message + ' 保存していません。', 'error'); return; }
    if (!res.ok) { toast(res.reason === 'quota' ? '端末の空きが足りず保存できませんでした。入力は残しています。' : '別の画面で記録が変わりました。もう一度保存してください。', 'error'); return; }
    const id = editing ? editing.id : rec.id;
    toast(editing ? '変更を保存しました' : '保存しました', 'success');
    editing = null; S.writeJSON(S.KEYS.draft, null);
    replaceState(blank()); app.go('history', { focus: id });
  }
  async function clearAll() {
    if (editing) { if (await ask('もとに戻す', '編集前の内容に戻しますか？', { ok: '戻す' })) load(JSON.parse(editing.original), { edit: true }); return; }
    if (isEmpty()) return;
    if (!(await ask('入力をクリア', '入力中の内容を消しますか？', { ok: '消す', danger: true }))) return;
    S.writeJSON(S.KEYS.draft, null); replaceState(blank());
  }
  async function cancelEdit() {
    if (!(await ask('編集をやめる', '変更は保存されません。編集をやめますか？', { ok: 'やめる' }))) return;
    editing = null; S.writeJSON(S.KEYS.draft, null); replaceState(blank());
  }
  // 状態は1つのオブジェクトを使い続ける（図や入力欄が同じものを見るように、中身だけ入れ替える）
  function replaceState(fresh) {
    Object.keys(st).forEach(k => delete st[k]); Object.assign(st, fresh);
    syncAll(); saveDraft();
  }

  function load(r, { edit = false } = {}) {
    const rec = S.normalizeRecord(r);
    const fresh = { ...blank(), board: rec.board, snow: rec.snow, stance: rec.stance, stanceWidth: rec.stanceWidth, leftAngle: rec.leftAngle, rightAngle: rec.rightAngle,
      disk: { ...rec.disk }, holes: { left: [...rec.holes.left], right: [...rec.holes.right] }, reference: { ...rec.reference },
      comment: edit ? rec.comment : '', detail: S.normalizeDetail(rec.detail) };
    if (!edit) fresh.detail.note = '';
    editing = edit ? { id: rec.id, original: JSON.stringify(rec), label: `${rec.board || '板名なし'}（${new Date(rec.dateTime).toLocaleDateString('ja-JP')}）` } : null;
    replaceState(fresh);
    if (S.hasDetail(rec.detail) && app.settings.mode !== 'detail') { app.setSetting({ mode: 'detail' }); applyMode(); }
  }

  async function copyShapeFromHistory() {
    const name = st.board.trim();
    if (!name) { toast('先に板の名前を入れてください。'); boardInput.focus(); return; }
    let items; try { items = S.sortByDate(S.readRecords().items); } catch (e) { toast(e.message, 'error'); return; }
    const src = items.find(r => r.board === name && (r.detail.shape || r.detail.nose || r.detail.bend || r.detail.boardNote));
    if (!src) { toast('この板の形状を記録した履歴はありません。'); return; }
    Object.assign(st.detail, { shape: src.detail.shape, nose: src.detail.nose, bend: src.detail.bend, boardNote: src.detail.boardNote });
    syncAll(); saveDraft(); toast('前回の形状を入れました。', 'success');
  }
  async function applyShapeToHistory() {
    const name = st.board.trim();
    const patch = Object.fromEntries(['shape', 'nose', 'bend', 'boardNote'].filter(k => d()[k]).map(k => [k, d()[k]]));
    if (!name) { toast('先に板の名前を入れてください。'); return; }
    if (!Object.keys(patch).length) { toast('反映する形状を入れてください。'); return; }
    let snap; try { snap = S.readRecords(); } catch (e) { toast(e.message, 'error'); return; }
    const targets = snap.items.filter(r => r.board === name && Object.entries(patch).some(([k, v]) => r.detail[k] !== v));
    if (!targets.length) { toast('同じ板の記録は、もう同じ形状です（または記録がありません）。'); return; }
    const labels = Object.entries(patch).map(([k, v]) => `${{ shape: 'シェイプ', nose: 'ノーズ', bend: 'ベンド', boardNote: '補足' }[k]}：${S.CHOICES[k]?.[v] ?? v}`);
    if (!(await ask('形状をまとめて反映', `「${name}」の記録 ${targets.length}件に反映します。\n${labels.join('\n')}\n空欄の項目と、角度・ビス穴などは変えません。`, { ok: '反映する' }))) return;
    const ids = new Set(targets.map(r => r.id));
    const res = S.writeRecords(snap.raw, snap.items.map(r => (ids.has(r.id) ? { ...r, detail: { ...r.detail, ...patch } } : r)));
    toast(res.ok ? `${targets.length}件に反映しました。` : '確認中に記録が変わりました。もう一度やり直してください。', res.ok ? 'success' : 'error');
    if (res.ok) app.refresh();
  }

  applyMode(); applyDir(); syncAll();
  // 記録画面に戻るたびに、設定画面で変えた入力モード・前足を反映する
  const show = () => { applyMode(); applyDir(); };
  return { el: root, show, applyDir, load, refreshBoards, isEditing: () => !!editing, hasInput: () => !isEmpty() || !!editing, restored: !!(restored && restored.state) };
}
