// 板を縦に置いた図（上＝ノーズ側）。
// レギュラー：上が左足、つま先側が右。グーフィー：上が右足、つま先側が左（左右を鏡に映した形）。
// 記録の番号は v2 と同じ：穴 0〜5 がつま先側の列、6〜11 がかかと側の列（どちらもノーズ側から順）。推奨位置は 0〜5。
import { h, $$ } from './ui.js';

const LABEL = { left: '左足', right: '右足' };
export const footOrder = dir => (dir === 'goofy' ? ['right', 'left'] : ['left', 'right']);

// 1 段分：かかと・推奨位置・つま先（グーフィーは逆順）
const rowCells = (dir, heel, ref, toe) => (dir === 'goofy' ? [toe, ref, heel] : [heel, ref, toe]);

export function bindingBoard(state, onChange, getDir) {
  const root = h('div.board', { role: 'group', 'aria-label': 'ビス穴と推奨位置' });

  function build() {
    const dir = getDir();
    root.dataset.dir = dir;
    const toeLabel = dir === 'goofy' ? '◀ つま先側' : 'つま先側 ▶';
    root.replaceChildren(h('div.board-ends', dir === 'goofy' ? [h('span', toeLabel), h('span', 'ノーズ側 ▲')] : [h('span', '▲ ノーズ側'), h('span', toeLabel)]));
    for (const side of footOrder(dir)) {
      const label = LABEL[side];
      const grid = h('div.mount-grid');
      for (let row = 0; row < 6; row++) {
        grid.append(...rowCells(dir,
          holeBtn(side, 6 + row, `${label} かかと側 ノーズから${row + 1}番目のビス穴`),
          h('button.ref', { type: 'button', dataset: { side, index: row }, 'aria-label': `${label} 推奨位置 ノーズから${row + 1}番目`, onclick: () => {
            state.reference[side] = state.reference[side] === row ? null : row; paint(); onChange();
          } }),
          holeBtn(side, row, `${label} つま先側 ノーズから${row + 1}番目のビス穴`)));
      }
      root.append(h('div.mount', { dataset: { side } },
        h('div.mount-head', h('strong', label, h('small', side === footOrder(dir)[0] ? '（前足）' : '（後ろ足）')), h('span.mount-sum')),
        h('div.mount-body', grid, h('div.foot-bar', { 'aria-hidden': 'true' }))));
    }
    root.append(h('div.board-ends', h('span', '▼ テール側')));
    paint();
  }

  function holeBtn(side, index, label) {
    return h('button.hole', { type: 'button', dataset: { side, index }, 'aria-label': label, onclick: () => {
      const list = state.holes[side];
      const at = list.indexOf(index);
      if (at >= 0) list.splice(at, 1); else list.push(index);
      list.sort((a, b) => a - b);
      paint(); onChange();
    } });
  }
  function paint() {
    const dir = getDir();
    if (root.dataset.dir !== dir) { build(); return; }
    for (const side of ['left', 'right']) {
      const m = root.querySelector(`.mount[data-side="${side}"]`);
      $$('.hole', m).forEach(b => b.setAttribute('aria-pressed', String(state.holes[side].includes(Number(b.dataset.index)))));
      $$('.ref', m).forEach(b => b.setAttribute('aria-pressed', String(state.reference[side] === Number(b.dataset.index))));
      const raw = side === 'left' ? state.leftAngle : state.rightAngle;
      const angle = Number(raw);
      const bar = m.querySelector('.foot-bar');
      bar.hidden = raw === '' || !Number.isFinite(angle);
      // 角度がプラス＝つま先がノーズ側を向く。つま先側が右なら左回り、左なら右回り
      bar.style.rotate = `${dir === 'goofy' ? angle : -angle}deg`;
      const n = state.holes[side].length;
      m.querySelector('.mount-sum').textContent = `${n ? `穴 ${n}個` : '穴 未選択'}${state.reference[side] !== null ? ' · 推奨位置あり' : ''}`;
    }
  }
  root.paint = paint;
  build();
  return root;
}

// 簡易入力用：1 本の足のビス穴を縦 2 列に並べる（上＝ノーズ側）。
// 列は「かかと・推奨位置・つま先」。グーフィーは鏡の形（つま先側が左）。
export function footMount(state, side, getDir, onChange) {
  const root = h('div.qmount', { role: 'group', 'aria-label': `${LABEL[side]}のビス穴` });
  function build() {
    const dir = getDir();
    root.dataset.dir = dir;
    const hole = i => h('button.hole', { type: 'button', dataset: { index: i }, 'aria-label': `${LABEL[side]} ${i < 6 ? 'つま先側' : 'かかと側'} ノーズから${(i % 6) + 1}番目`, onclick: () => {
      const list = state.holes[side], at = list.indexOf(i);
      if (at >= 0) list.splice(at, 1); else list.push(i);
      list.sort((a, b) => a - b); paint(); onChange();
    } });
    const grid = h('div.qmount-grid');
    for (let row = 0; row < 6; row++) {
      grid.append(...rowCells(dir, hole(6 + row),
        h('button.ref', { type: 'button', dataset: { index: row }, 'aria-label': `${LABEL[side]} 推奨位置 ノーズから${row + 1}番目`, onclick: () => {
          state.reference[side] = state.reference[side] === row ? null : row; paint(); onChange();
        } }),
        hole(row)));
    }
    root.replaceChildren(grid);
    paint();
  }
  function paint() {
    if (root.dataset.dir !== getDir()) { build(); return; }
    $$('.hole', root).forEach(b => b.setAttribute('aria-pressed', String(state.holes[side].includes(Number(b.dataset.index)))));
    $$('.ref', root).forEach(b => b.setAttribute('aria-pressed', String(state.reference[side] === Number(b.dataset.index))));
  }
  root.paint = paint;
  build();
  return root;
}

// 履歴用の小さい図（押せない）。前足を左に置き、つま先側の向きもスタンスに合わせる
export function miniBoard(r, dir = 'regular') {
  const wrap = h('div.mini-board', { role: 'img', 'aria-label': `ビス穴の図（${dir === 'goofy' ? 'グーフィー' : 'レギュラー'}）` });
  for (const side of footOrder(dir)) {
    const g = h('div.mini-mount', h('b', side === 'left' ? '左' : '右'));
    for (let row = 0; row < 6; row++) {
      g.append(...rowCells(dir,
        h('i' + (r.holes[side].includes(6 + row) ? '.on' : '')),
        h('i.r' + (r.reference[side] === row ? '.on' : '')),
        h('i' + (r.holes[side].includes(row) ? '.on' : ''))));
    }
    wrap.append(g);
  }
  return wrap;
}
