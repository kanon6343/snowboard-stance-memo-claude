// 小さな UI 部品：要素づくり、トースト、下から出るシート、確認

// h('button.primary', {onclick}, '保存') のように要素を作る
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer;
export function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => (el.hidden = true), 250); }, kind === 'error' ? 4200 : 2400);
}

// 下から出るシート（<dialog>）。閉じたら消える
export function sheet(title, body, { actions = [], wide = false, onClose } = {}) {
  const close = h('button.icon-btn', { type: 'button', 'aria-label': '閉じる', onclick: () => dlg.close() }, '×');
  const dlg = h('dialog.sheet' + (wide ? '.wide' : ''), { 'aria-label': title },
    h('div.sheet-grip', { 'aria-hidden': 'true' }),
    h('header.sheet-head', h('h2', title), close),
    h('div.sheet-body', body),
    actions.length ? h('footer.sheet-foot', actions) : null);
  // 閉じた後の処理は1回だけ。close イベントが遅れる環境もあるので、close() から直接呼ぶ
  let done = false;
  const finish = () => { if (done) return; done = true; dlg.remove(); onClose?.(); };
  const nativeClose = dlg.close.bind(dlg);
  dlg.close = value => { if (dlg.open) nativeClose(value); finish(); };
  dlg.addEventListener('cancel', e => { e.preventDefault(); dlg.close(); });   // Esc キー・戻る操作
  dlg.addEventListener('close', finish);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// 確認。Promise<boolean>
export function ask(title, message, { ok = 'OK', cancel = 'キャンセル', danger = false } = {}) {
  return new Promise(resolve => {
    let answer = false;
    const body = h('div', String(message).split('\n').map(line => (line ? h('p', line) : h('br'))));
    const dlg = sheet(title, body, {
      actions: [
        h('button.btn.ghost', { type: 'button', onclick: () => dlg.close() }, cancel),
        h('button.btn' + (danger ? '.danger' : '.primary'), { type: 'button', onclick: () => { answer = true; dlg.close(); } }, ok),
      ],
      onClose: () => resolve(answer),
    });
  });
}

// 横並びの選択ボタン（もう一度押すと外れる）
export function segmented(options, value, onChange, { allowEmpty = true, label } = {}) {
  const wrap = h('div.segmented', { role: 'group', 'aria-label': label });
  const paint = v => $$('button', wrap).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
  for (const [v, text] of options) {
    wrap.append(h('button', { type: 'button', dataset: { value: v }, onclick: () => {
      const next = allowEmpty && wrap.dataset.current === v ? '' : v;
      wrap.dataset.current = next; paint(next); onChange(next);
    } }, text));
  }
  wrap.set = v => { wrap.dataset.current = v || ''; paint(v || ''); };
  wrap.set(value);
  return wrap;
}

export function download(filename, text, type = 'application/json') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

const WD = '日月火水木金土';
export function fmtDate(iso, withTime = true) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '日時なし';
  const s = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  return withTime ? `${s} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : s;
}
export const dayLabel = date => { const d = new Date(date + 'T00:00:00+09:00'); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
export const signed = v => (v === '' || v === null || v === undefined ? '—' : `${Number(v) > 0 ? '+' : ''}${v}°`);
