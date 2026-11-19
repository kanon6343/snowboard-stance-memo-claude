// 板を縦に置いた図。上が左足、下が右足。左右とも「左の列＝かかと側、右の列＝つま先側、真ん中＝推奨位置」。
// 記録の番号は v2 と同じ：穴 0〜5 がつま先側の列、6〜11 がかかと側の列（どちらも上から順）。推奨位置は 0〜5。
import { h, $$ } from './ui.js';

const SIDES = [['left', '左足'], ['right', '右足']];

export function bindingBoard(state, onChange) {
  const root = h('div.board', { role: 'group', 'aria-label': 'ビス穴と推奨位置' },
    h('div.board-ends', h('span', '▲ ノーズ側'), h('span', 'つま先側 ▶')));
  for (const [side, label] of SIDES) {
    const foot = h('div.mount', { dataset: { side } });
    const head = h('div.mount-head', h('strong', label), h('span.mount-sum'));
    const grid = h('div.mount-grid');
    for (let row = 0; row < 6; row++) {
      grid.append(
        holeBtn(side, 6 + row, `${label} かかと側 ${row + 1}番目のビス穴`),
        h('button.ref', { type: 'button', dataset: { side, index: row }, 'aria-label': `${label} 推奨位置 ${row + 1}`, onclick: () => {
          state.reference[side] = state.reference[side] === row ? null : row; paint(); onChange();
        } }),
        holeBtn(side, row, `${label} つま先側 ${row + 1}番目のビス穴`));
    }
    const angleBar = h('div.foot-bar', { 'aria-hidden': 'true' });
    foot.append(head, h('div.mount-body', grid, angleBar));
    root.append(foot);
  }
  root.append(h('div.board-ends', h('span', '▼ テール側'), h('span')));

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
    for (const [side] of SIDES) {
      const m = root.querySelector(`.mount[data-side="${side}"]`);
      $$('.hole', m).forEach(b => b.setAttribute('aria-pressed', String(state.holes[side].includes(Number(b.dataset.index)))));
      $$('.ref', m).forEach(b => b.setAttribute('aria-pressed', String(state.reference[side] === Number(b.dataset.index))));
      const angle = Number(side === 'left' ? state.leftAngle : state.rightAngle);
      const bar = m.querySelector('.foot-bar');
      bar.hidden = !Number.isFinite(angle) || (side === 'left' ? state.leftAngle : state.rightAngle) === '';
      bar.style.rotate = `${-angle}deg`;
      const n = state.holes[side].length;
      m.querySelector('.mount-sum').textContent = `${n ? `穴 ${n}個` : '穴 未選択'}${state.reference[side] !== null ? ' · 推奨位置あり' : ''}`;
    }
  }
  root.paint = paint;
  paint();
  return root;
}

// 履歴用の小さい図（押せない）
export function miniBoard(r) {
  const wrap = h('div.mini-board', { 'aria-hidden': 'true' });
  for (const [side] of SIDES) {
    const g = h('div.mini-mount');
    for (let row = 0; row < 6; row++) {
      g.append(h('i' + (r.holes[side].includes(6 + row) ? '.on' : '')), h('i.r' + (r.reference[side] === row ? '.on' : '')), h('i' + (r.holes[side].includes(row) ? '.on' : '')));
    }
    wrap.append(g);
  }
  return wrap;
}
