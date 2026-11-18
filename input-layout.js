/* Claude試作: 入力画面の並び替え（ホーム画面のウィジェット配置のように）と、左右の足の同時表示。
   見た目の設定だけで、記録のデータには触れない。設定はこの端末に保存する（キー claude:input-layout-v1）。
   - 入力画面の何もない所を長押し（またはメニューのボタン）で並び替えモード。各まとまりが小さくなって揺れる。
   - まとまりをつかんで動かすと、ほかのまとまりがよけて並び直る。「−」で外し、下の「+」で戻す。 */
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
    {id: 'feet', label: '左右の足', fixed: true, nodes: ['#footDockSentinel', '#footDock', '.bindings']},
    {id: 'comment', label: 'コメント', nodes: ['#commentDetails']},
  ];
  const DEFAULT = BLOCKS.map(b => b.id);
  const info = id => BLOCKS.find(b => b.id === id);
  const byId = id => document.getElementById(id);
  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const INTERACTIVE = 'input,select,textarea,button,a,label,summary,[role="tab"],[contenteditable],.hole,.ref-slot,.chip,.board-suggestions';
  let settings = {order: DEFAULT.slice(), off: [], feet: 'tabs'};
  let editing = false, tutorial = false;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s || typeof s !== 'object') return;
      if (Array.isArray(s.order)) settings.order = [...new Set(s.order.filter(id => DEFAULT.includes(id))), ...DEFAULT.filter(id => !s.order.includes(id))];
      if (Array.isArray(s.off)) settings.off = s.off.filter(id => DEFAULT.includes(id) && !info(id).fixed);
      if (s.feet === 'both') settings.feet = 'both';
    } catch { /* 読めなければ最初の並び */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); return true; } catch { return false; }
  }

  // ---- 入力画面をまとまり（ウィジェット）に分ける。中身の HTML と ID は変えない
  const blocks = new Map();
  for (const b of BLOCKS) {
    const nodes = b.nodes.map(sel => card.querySelector(':scope > ' + sel)).filter(Boolean);
    if (!nodes.length) continue;
    const wrap = document.createElement('div');
    wrap.className = 'layout-block';
    wrap.dataset.block = b.id;
    if (b.detail) wrap.dataset.detailOnly = 'true';
    nodes[0].before(wrap);
    const tag = document.createElement('div');
    tag.className = 'layout-tag';
    tag.innerHTML = '<span class="layout-name"></span>' + (b.fixed ? '' : '<button type="button" class="layout-remove" aria-label="">−</button>');
    tag.querySelector('.layout-name').textContent = b.label + (b.detail ? '（詳細入力）' : '');
    tag.querySelector('.layout-remove')?.setAttribute('aria-label', b.label + 'を画面から外す');
    const content = document.createElement('div');
    content.className = 'layout-content';
    content.append(...nodes);
    wrap.append(tag, content);
    blocks.set(b.id, wrap);
  }
  const anchor = document.createComment('input-layout-end');
  [...blocks.values()].at(-1)?.after(anchor);

  const tray = document.createElement('div');
  tray.className = 'layout-tray';
  tray.hidden = true;
  anchor.after(tray);

  const notice = document.createElement('p');
  notice.className = 'layout-hidden-notice';
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  card.prepend(notice);

  const toolbar = document.createElement('div');
  toolbar.className = 'layout-toolbar';
  toolbar.hidden = true;
  toolbar.innerHTML = '<div class="layout-toolbar-text"><strong>並びを変える</strong><p>まとまりをつかんで動かします。「−」で外し、下の「＋」で戻せます。</p></div>'
    + '<button type="button" id="layoutDone" class="layout-done">完了</button>'
    + '<p id="layoutLive" class="layout-live" role="status" aria-live="polite"></p>';
  card.prepend(toolbar);

  // ---- 並びと表示を反映
  function apply() {
    const order = tutorial ? DEFAULT : settings.order;
    for (const id of order) { const el = blocks.get(id); if (el) anchor.before(el); }
    for (const [id, el] of blocks) el.dataset.off = String(!tutorial && settings.off.includes(id));
    drawTray();
    applyFeet();
    checkHidden();
  }
  function drawTray() {
    const off = settings.off.filter(id => blocks.has(id));
    tray.replaceChildren();
    const h = document.createElement('p');
    h.className = 'layout-tray-title';
    h.textContent = off.length ? '外した項目（押すと戻ります）' : '外した項目はありません';
    tray.append(h);
    for (const id of off) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'layout-add';
      b.dataset.id = id;
      b.textContent = '＋ ' + info(id).label;
      tray.append(b);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'layout-reset';
    reset.textContent = '最初の並びに戻す';
    tray.append(reset);
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
  if (typeof MutationObserver === 'function') {
    // 両方表示の時は、ほかの処理が片方を隠しても戻す
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

  // ---- 外したまとまりに入力が残っていたら知らせる
  function hasValue(el) {
    if ([...el.querySelectorAll('input:not([type=hidden]),textarea')].some(i => i.value.trim() !== '')) return true;
    if ([...el.querySelectorAll('select')].some(s => !s.hidden && s.value !== '' && !s.closest('[hidden]'))) return true;
    return !!el.querySelector('[data-stance].active, [data-stance][aria-pressed="true"]');
  }
  function checkHidden() {
    const names = settings.off.filter(id => {
      const el = blocks.get(id);
      if (!el || tutorial) return false;
      if (info(id).detail && document.documentElement.dataset.inputMode !== 'detail') return false;
      return hasValue(el);
    }).map(id => info(id).label);
    notice.hidden = !names.length || editing;
    notice.textContent = names.length ? '外した「' + names.join('」「') + '」に入力があります。保存すると一緒に記録されます。' : '';
  }
  setInterval(() => { if (settings.off.length) checkHidden(); }, 1500);

  // ---- 並び替えモードに入る・出る
  const current = () => [...card.querySelectorAll(':scope > .layout-block')].filter(el => el.dataset.off !== 'true');
  function start() {
    if (tutorial || editing) return;
    if (typeof MenuControls !== 'undefined' && MenuControls.close) MenuControls.close();
    if (typeof showView === 'function') showView('input');
    editing = true;
    document.activeElement?.blur?.();
    card.classList.add('layout-editing');
    if (!reduced()) card.classList.add('layout-wiggle');
    toolbar.hidden = false;
    tray.hidden = false;
    notice.hidden = true;
    blocks.forEach(el => { el.querySelector('.layout-content').inert = true; el.tabIndex = 0; el.setAttribute('aria-label', info(el.dataset.block).label + '。上下の矢印キーで移動'); });
    drawTray();
    try { navigator.vibrate?.(12); } catch { /* 振動できない端末 */ }
    requestAnimationFrame(() => card.scrollIntoView({block: 'start', behavior: reduced() ? 'auto' : 'smooth'}));
    byId('layoutLive').textContent = '';
  }
  function finish() {
    if (!editing) return;
    endDrag();
    editing = false;
    card.classList.remove('layout-editing', 'layout-wiggle');
    toolbar.hidden = true;
    tray.hidden = true;
    blocks.forEach(el => {
      el.querySelector('.layout-content').inert = false; el.removeAttribute('tabindex'); el.removeAttribute('aria-label');
      el.style.transform = ''; el.style.transition = ''; delete el.dataset.dy;   // 動きの途中の位置を残さない
    });
    settings.order = [...card.querySelectorAll(':scope > .layout-block')].map(el => el.dataset.block);
    const ok = save();
    const st = byId('inputLayoutStatus');
    if (st) st.textContent = ok ? '並びを保存しました（この端末に記憶）。' : '並びを保存できませんでした。この端末の保存領域を確認してください。';
    apply();
  }
  function announce(el) {
    const list = current(), i = list.indexOf(el);
    byId('layoutLive').textContent = info(el.dataset.block).label + '：' + (i + 1) + '番目 / ' + list.length;
  }

  // ほかのまとまりが、よけるように動く（FLIP）
  function animateMove(change) {
    const others = [...blocks.values()];
    const before = new Map(others.map(el => [el, el.offsetParent ? el.offsetTop : null]));
    change();
    if (reduced()) return;
    for (const el of others) {
      if ((drag && el === drag.el) || el.dataset.off === 'true' || before.get(el) === null) continue;
      const dy = before.get(el) - el.offsetTop;
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + dy + 'px)';
      requestAnimationFrame(() => { el.style.transition = 'transform .22s ease'; el.style.transform = ''; });
    }
  }

  // ---- 長押しで並び替えモードへ（入力欄やボタンの上では反応しない）
  let press = null;
  card.addEventListener('pointerdown', e => {
    if (editing || tutorial || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest(INTERACTIVE) || !e.target.closest('.layout-block')) return;
    press = {x: e.clientX, y: e.clientY, id: e.pointerId, timer: setTimeout(() => { press = null; start(); suppressClick = true; }, 550)};
  });
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  card.addEventListener('pointermove', e => { if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress(); });
  ['pointerup', 'pointercancel'].forEach(t => card.addEventListener(t, cancelPress));
  window.addEventListener('scroll', cancelPress, {passive: true});
  let suppressClick = false;
  card.addEventListener('click', e => { if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); } }, true);
  card.addEventListener('contextmenu', e => { if (editing || press) e.preventDefault(); });

  // ---- 並び替えモードのドラッグ（少し押さえてから動かす。すぐ動かすとページのスクロール）
  let drag = null, hold = null;
  card.addEventListener('pointerdown', e => {
    if (!editing || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = e.target.closest('.layout-block');
    if (!el || el.dataset.off === 'true' || e.target.closest('.layout-remove')) return;
    e.stopPropagation();   // 入力・履歴の左右スワイプにしない
    const begin = () => {
      hold = null;
      try { el.setPointerCapture(e.pointerId); } catch { /* 取れなくても動かせる */ }
      drag = {el, id: e.pointerId, y: lastY, start: lastY, raf: 0};
      el.classList.add('dragging');
      try { navigator.vibrate?.(8); } catch { /* なし */ }
    };
    let lastY = e.clientY;
    if (e.pointerType === 'mouse') { begin(); return; }
    hold = {id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(begin, 180), track: ev => { lastY = ev.clientY; }};
  }, true);
  card.addEventListener('touchstart', e => { if (editing) e.stopPropagation(); }, {passive: true});
  // つかんでいる間はページをスクロールさせない
  document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, {passive: false});

  function place(clientY) {
    // 位置は offsetTop（動き中の transform に左右されない）で比べる。カードが基準（position:relative）
    const {el} = drag;
    const cardTop = card.getBoundingClientRect().top;
    const before = el.offsetTop;
    const others = current().filter(x => x !== el);
    let target = null;
    for (const other of others) {
      if (clientY < cardTop + other.offsetTop + other.offsetHeight / 2) { target = other; break; }
    }
    const next = target || anchor;
    if (el.nextSibling !== next) { animateMove(() => next.before(el)); announce(el); }
    drag.start += el.offsetTop - before;
    const dy = clientY - drag.start;
    el.dataset.dy = String(dy);
    el.style.transition = 'none';
    el.style.transform = 'translateY(' + dy + 'px) scale(1.03)';
  }
  function autoScroll() {
    if (!drag) return;
    const edge = 80, y = drag.y;
    let v = 0;
    if (y < edge) v = -Math.ceil((edge - y) / 5);
    else if (y > innerHeight - edge) v = Math.ceil((y - (innerHeight - edge)) / 5);
    if (v) {
      const s0 = scrollY; scrollBy(0, v); const ds = scrollY - s0;
      if (ds) { drag.start -= ds; place(drag.y); }
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }
  card.addEventListener('pointermove', e => {
    if (hold && e.pointerId === hold.id) {
      hold.track(e);
      if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) { clearTimeout(hold.timer); hold = null; }   // スクロールしたい
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    drag.y = e.clientY;
    place(e.clientY);
    if (!drag.raf) drag.raf = requestAnimationFrame(autoScroll);
  });
  function endDrag(e) {
    if (hold && (!e || e.pointerId === hold.id)) { clearTimeout(hold.timer); hold = null; }
    if (!drag || (e && e.pointerId !== drag.id)) return;
    cancelAnimationFrame(drag.raf);
    const {el} = drag;
    drag = null;
    el.classList.remove('dragging');
    delete el.dataset.dy;
    el.style.transition = reduced() ? 'none' : 'transform .2s ease';
    el.style.transform = '';
    announce(el);
  }
  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);
  card.addEventListener('lostpointercapture', endDrag);

  // キーボードでも動かせる
  card.addEventListener('keydown', e => {
    if (!editing) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(); byId('editInputLayout')?.focus(); return; }
    const el = e.target.closest?.('.layout-block');
    if (!el || e.target !== el || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const list = current(), i = list.indexOf(el);
    animateMove(() => {
      if (e.key === 'ArrowUp' && i > 0) list[i - 1].before(el);
      if (e.key === 'ArrowDown' && i < list.length - 1) list[i + 1].after(el);
    });
    el.focus();
    announce(el);
  });

  // 外す・戻す・完了
  card.addEventListener('click', e => {
    if (!editing) return;
    const rm = e.target.closest('.layout-remove');
    if (rm) {
      const el = rm.closest('.layout-block'), id = el.dataset.block;
      animateMove(() => { settings.off = [...new Set([...settings.off, id])]; el.dataset.off = 'true'; });
      drawTray();
      byId('layoutLive').textContent = info(id).label + 'を外しました。下の「＋」で戻せます。';
      return;
    }
    const add = e.target.closest('.layout-add');
    if (add) {
      const id = add.dataset.id, el = blocks.get(id);
      animateMove(() => { settings.off = settings.off.filter(x => x !== id); el.dataset.off = 'false'; });
      drawTray();
      byId('layoutLive').textContent = info(id).label + 'を戻しました。';
      return;
    }
    if (e.target.closest('.layout-reset')) {
      animateMove(() => {
        settings.off = [];
        for (const id of DEFAULT) { const el = blocks.get(id); el.dataset.off = 'false'; anchor.before(el); }
      });
      drawTray();
      byId('layoutLive').textContent = '最初の並びに戻しました。「完了」で保存します。';
      return;
    }
    if (e.target.closest('#layoutDone')) finish();
  });

  // ---- メニューの設定
  byId('editInputLayout')?.addEventListener('click', start);
  byId('footLayout')?.addEventListener('change', e => {
    settings.feet = e.target.value === 'both' ? 'both' : 'tabs';
    const ok = save();
    applyFeet();
    const st = byId('inputLayoutStatus');
    if (st) st.textContent = ok ? (settings.feet === 'both' ? '左右の足を横に並べて表示します。' : '左右の足を切り替えて表示します。') : '設定を保存できませんでした。';
  });

  load();
  apply();
  return {start, finish, editing: () => editing, settings: () => JSON.parse(JSON.stringify(settings))};
})();
