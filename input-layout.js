/* Claude試作: 入力画面の並び替え・表示切り替えと、左右の足の同時表示。
   見た目の設定だけで、記録のデータには触れない。設定はこの端末に保存する（キー claude:input-layout-v1）。 */
const InputLayout = (() => {
  'use strict';
  const KEY = 'claude:input-layout-v1';
  const card = document.getElementById('setupCard');
  if (!card) return null;
  const BLOCKS = [
    {id: 'meta', label: '板名・雪質', nodes: ['.setup-meta']},
    {id: 'shape', label: '板の形状', detail: true, nodes: ['#boardProfileNotice', '#detailFields']},
    {id: 'stance', label: 'スタンス・幅', nodes: ['.stance-row']},
    {id: 'setback', label: 'セットバック', detail: true, nodes: ['#detailSetback']},
    {id: 'binding', label: 'ビンディング', detail: true, nodes: ['#detailBindingFields', '#bindingProfileStatus']},
    {id: 'feet', label: '左右の足（角度・ディスク・ビス穴）', fixed: true, nodes: ['#footDockSentinel', '#footDock', '.bindings']},
    {id: 'comment', label: 'コメント', nodes: ['#commentDetails']},
  ];
  const DEFAULT = BLOCKS.map(b => b.id);
  const byId = id => document.getElementById(id);
  let settings = {order: DEFAULT.slice(), off: [], feet: 'tabs'};
  let editing = false, tutorial = false;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s || typeof s !== 'object') return;
      if (Array.isArray(s.order)) settings.order = [...new Set(s.order.filter(id => DEFAULT.includes(id))), ...DEFAULT.filter(id => !s.order.includes(id))];
      if (Array.isArray(s.off)) settings.off = s.off.filter(id => DEFAULT.includes(id) && !BLOCKS.find(b => b.id === id).fixed);
      if (s.feet === 'both') settings.feet = 'both';
    } catch { /* 読めなければ最初の並び */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); return true; } catch { return false; }
  }

  // ---- 入力画面をまとまり（ブロック）に分ける
  const blocks = new Map();
  for (const b of BLOCKS) {
    const nodes = b.nodes.map(sel => card.querySelector(':scope > ' + sel)).filter(Boolean);
    if (!nodes.length) continue;
    const wrap = document.createElement('div');
    wrap.className = 'layout-block';
    wrap.dataset.block = b.id;
    if (b.detail) wrap.dataset.detailOnly = 'true';
    nodes[0].before(wrap);
    const bar = document.createElement('div');
    bar.className = 'layout-bar';
    bar.innerHTML = '<button type="button" class="layout-grip"><span class="layout-grip-icon" aria-hidden="true">≡</span><span class="layout-name"></span></button>'
      + (b.fixed ? '<span class="layout-fixed">常に表示</span>' : '<button type="button" class="layout-eye" aria-pressed="true">表示中</button>');
    bar.querySelector('.layout-name').textContent = b.label + (b.detail ? '（詳細入力のとき）' : '');
    bar.querySelector('.layout-grip').setAttribute('aria-label', b.label + 'を移動。上下の矢印キーでも動かせます');
    wrap.append(bar, ...nodes);
    blocks.set(b.id, wrap);
  }
  const anchor = document.createComment('input-layout-end');
  [...blocks.values()].at(-1)?.after(anchor);

  const notice = document.createElement('p');
  notice.className = 'layout-hidden-notice';
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  card.prepend(notice);

  const toolbar = document.createElement('div');
  toolbar.className = 'layout-toolbar';
  toolbar.hidden = true;
  toolbar.innerHTML = '<div><strong>入力画面の並びを変える</strong><p>≡ の行をつかんで上下に動かします。「表示中」を押すと隠せます。</p></div>'
    + '<div class="layout-toolbar-actions"><button type="button" id="layoutReset">最初の並びに戻す</button><button type="button" id="layoutDone" class="layout-done">完了</button></div>'
    + '<p id="layoutLive" class="layout-live" role="status" aria-live="polite"></p>';
  card.prepend(toolbar);

  // ---- 並びと表示を反映
  function apply() {
    const order = tutorial ? DEFAULT : settings.order;
    for (const id of order) { const el = blocks.get(id); if (el) anchor.before(el); }
    for (const [id, el] of blocks) {
      const off = !tutorial && settings.off.includes(id);
      el.dataset.off = String(off);
      const eye = el.querySelector('.layout-eye');
      if (eye) { eye.setAttribute('aria-pressed', String(!off)); eye.textContent = off ? '非表示' : '表示中'; }
    }
    applyFeet();
    checkHidden();
  }
  function applyFeet() {
    const both = settings.feet === 'both';
    document.documentElement.dataset.footLayout = both ? 'both' : 'tabs';
    const sel = byId('footLayout');
    if (sel) sel.value = settings.feet;
    if (both) ['leftFootPanel', 'rightFootPanel'].forEach(id => { const p = byId(id); if (p && p.hidden) p.hidden = false; });
    else if (byId('leftFootPanel') && !byId('leftFootPanel').hidden && !byId('rightFootPanel').hidden && typeof showFoot === 'function') showFoot('left');
    if (typeof renderRefSlots === 'function') renderRefSlots();
    if (typeof FootDock !== 'undefined' && FootDock) FootDock.sync();
  }
  // 両方表示の時は、ほかの処理が片方を隠しても戻す
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => {
      if (settings.feet !== 'both') return;
      ['leftFootPanel', 'rightFootPanel'].forEach(id => { const p = byId(id); if (p && p.hidden) p.hidden = false; });
    });
    ['leftFootPanel', 'rightFootPanel'].forEach(id => byId(id) && mo.observe(byId(id), {attributes: true, attributeFilter: ['hidden']}));
    // 使い方ガイドの間は、最初の並びで見せる
    new MutationObserver(() => {
      const now = document.documentElement.dataset.tutorialActive === 'true';
      if (now !== tutorial) { tutorial = now; if (tutorial && editing) finish(); apply(); }
    }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-tutorial-active']});
  }

  // ---- 隠したまとまりに入力が残っていたら知らせる
  function hasValue(el) {
    if ([...el.querySelectorAll('input:not([type=hidden]),textarea')].some(i => i.value.trim() !== '')) return true;
    if ([...el.querySelectorAll('select')].some(s => !s.hidden && s.value !== '' && !s.closest('[hidden]'))) return true;
    return !!el.querySelector('[data-stance][aria-pressed="true"], [data-stance].active');
  }
  function checkHidden() {
    const names = settings.off.filter(id => {
      const el = blocks.get(id), b = BLOCKS.find(x => x.id === id);
      if (!el || tutorial) return false;
      if (b.detail && document.documentElement.dataset.inputMode !== 'detail') return false;
      return hasValue(el);
    }).map(id => BLOCKS.find(b => b.id === id).label);
    notice.hidden = !names.length || editing;
    notice.textContent = names.length ? '非表示にした「' + names.join('」「') + '」に入力があります。保存すると一緒に記録されます。' : '';
  }
  setInterval(() => { if (settings.off.length) checkHidden(); }, 1500);

  // ---- 並び替えモード
  function start() {
    if (tutorial) return;
    if (typeof MenuControls !== 'undefined' && MenuControls.close) MenuControls.close();
    if (typeof showView === 'function') showView('input');
    editing = true;
    card.classList.add('layout-editing');
    toolbar.hidden = false;
    notice.hidden = true;
    blocks.forEach(el => el.querySelectorAll(':scope > :not(.layout-bar)').forEach(n => { n.inert = true; }));
    requestAnimationFrame(() => card.scrollIntoView({block: 'start', behavior: reduced() ? 'auto' : 'smooth'}));
    byId('layoutLive').textContent = '';
  }
  function finish() {
    editing = false;
    card.classList.remove('layout-editing');
    toolbar.hidden = true;
    blocks.forEach(el => el.querySelectorAll(':scope > :not(.layout-bar)').forEach(n => { n.inert = false; }));
    settings.order = [...card.querySelectorAll(':scope > .layout-block')].map(el => el.dataset.block);
    const ok = save();
    const st = byId('inputLayoutStatus');
    if (st) st.textContent = ok ? '並びを保存しました（この端末に記憶）。' : '並びを保存できませんでした。この端末の保存領域を確認してください。';
    apply();
    if (typeof renderRefSlots === 'function') renderRefSlots();
  }
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const current = () => [...card.querySelectorAll(':scope > .layout-block')];
  function announce(el) {
    const list = current(), i = list.indexOf(el);
    byId('layoutLive').textContent = BLOCKS.find(b => b.id === el.dataset.block).label + '：' + (i + 1) + '番目 / ' + list.length;
  }

  // ドラッグ（指・マウス共通）
  let drag = null;
  card.addEventListener('pointerdown', e => {
    if (!editing) return;
    const bar = e.target.closest('.layout-bar');
    if (!bar || e.target.closest('.layout-eye') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = bar.parentElement;
    e.preventDefault();
    try { bar.setPointerCapture(e.pointerId); } catch { /* 取れなくても動かせる */ }
    drag = {el, bar, id: e.pointerId, y: e.clientY, start: e.clientY, top: el.getBoundingClientRect().top, raf: 0, moved: false};
    el.classList.add('dragging');
  });
  function place(clientY) {
    const {el} = drag;
    const before = el.getBoundingClientRect().top - (parseFloat(el.dataset.dy) || 0);
    const list = current().filter(x => x !== el);
    let target = null;
    for (const other of list) {
      const r = other.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { target = other; break; }
    }
    const next = target || anchor;   // ブロックは anchor の前に続けて並んでいる
    if (el.nextSibling !== next) { next.before(el); drag.moved = true; announce(el); }
    const after = el.getBoundingClientRect().top - (parseFloat(el.dataset.dy) || 0);
    drag.start += after - before;
    const dy = clientY - drag.start;
    el.dataset.dy = String(dy);
    el.style.transform = 'translateY(' + dy + 'px)';
  }
  function autoScroll() {
    if (!drag) return;
    const edge = 70, y = drag.y;
    let v = 0;
    if (y < edge) v = -Math.ceil((edge - y) / 6);
    else if (y > innerHeight - edge) v = Math.ceil((y - (innerHeight - edge)) / 6);
    if (v) {
      const s0 = scrollY; scrollBy(0, v); const ds = scrollY - s0;
      if (ds) { drag.start -= ds; place(drag.y); }
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }
  card.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.y = e.clientY;
    place(e.clientY);
    if (!drag.raf) drag.raf = requestAnimationFrame(autoScroll);
  });
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    cancelAnimationFrame(drag.raf);
    const {el} = drag;
    el.classList.remove('dragging');
    el.style.transform = '';
    delete el.dataset.dy;
    if (drag.moved) announce(el);
    drag = null;
  }
  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);
  card.addEventListener('lostpointercapture', endDrag);

  // キーボードでも動かせる
  card.addEventListener('keydown', e => {
    if (!editing) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); byId('editInputLayout')?.focus(); return; }
    const grip = e.target.closest('.layout-grip');
    if (!grip || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const el = grip.closest('.layout-block'), list = current(), i = list.indexOf(el);
    if (e.key === 'ArrowUp' && i > 0) list[i - 1].before(el);
    if (e.key === 'ArrowDown' && i < list.length - 1) list[i + 1].after(el);
    grip.focus();
    announce(el);
  });
  card.addEventListener('click', e => {
    if (!editing) return;
    const eye = e.target.closest('.layout-eye');
    if (eye) {
      const id = eye.closest('.layout-block').dataset.block;
      settings.off = settings.off.includes(id) ? settings.off.filter(x => x !== id) : [...settings.off, id];
      const off = settings.off.includes(id);
      eye.closest('.layout-block').dataset.off = String(off);
      eye.setAttribute('aria-pressed', String(!off));
      eye.textContent = off ? '非表示' : '表示中';
      return;
    }
    if (e.target.closest('#layoutDone')) finish();
    if (e.target.closest('#layoutReset')) {
      settings.off = [];
      for (const id of DEFAULT) anchor.before(blocks.get(id));
      blocks.forEach(el => { el.dataset.off = 'false'; const eye2 = el.querySelector('.layout-eye'); if (eye2) { eye2.setAttribute('aria-pressed', 'true'); eye2.textContent = '表示中'; } });
      byId('layoutLive').textContent = '最初の並びに戻しました。「完了」で保存します。';
    }
  });

  // ---- メニューの設定
  byId('editInputLayout')?.addEventListener('click', start);
  byId('footLayout')?.addEventListener('change', e => {
    settings.feet = e.target.value === 'both' ? 'both' : 'tabs';
    const ok = save();
    applyFeet();
    const st = byId('inputLayoutStatus');
    if (st) st.textContent = ok ? (settings.feet === 'both' ? '左右の足を同時に表示します。' : '左右の足を切り替えて表示します。') : '設定を保存できませんでした。';
  });

  load();
  apply();
  return {start, finish, settings: () => JSON.parse(JSON.stringify(settings))};
})();
