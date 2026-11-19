// 起動と画面の切り替え、テーマ、オフライン（Service Worker）、インストール
import { h, $, $$, toast } from './ui.js';
import * as S from './store.js';
import { createRecordView } from './record.js';
import { createHistoryView } from './history.js';
import { createSnowView } from './snow.js';
import { createSettingsView } from './settings.js';

const VIEWS = [['record', '記録', '✎'], ['history', '履歴', '☰'], ['snow', '雪山', '❄'], ['settings', '設定', '⚙']];

const app = {
  settings: S.readSettings(),
  current: null,
  updateState: 'unknown',
  setSetting(patch) { this.settings = S.saveSettings(patch); },
  applyTheme() {
    const t = this.settings.theme;
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    $('meta[name="theme-color"]').content = dark ? '#0f1a22' : '#0b5a7a';
  },
  go(view, opts = {}) {
    if (!VIEWS.some(([v]) => v === view)) view = 'record';
    this.current = view;
    $$('.view').forEach(el => (el.hidden = el.id !== `view-${view}`));
    $$('.tabbar button').forEach(b => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    this.views[view].show?.(opts);
    window.scrollTo(0, 0);
  },
  refresh() { this.views.history.refresh(); },
};

function boot() {
  app.applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.applyTheme());
  app.record = createRecordView(app);
  app.views = { record: app.record, history: createHistoryView(app), snow: createSnowView(app), settings: createSettingsView(app) };
  const main = $('#main');
  main.replaceChildren(...Object.values(app.views).map(v => v.el));
  $('#tabbar').replaceChildren(...VIEWS.map(([v, label, icon]) =>
    h('button', { type: 'button', dataset: { view: v }, onclick: () => app.go(v) }, h('span.tab-icon', { 'aria-hidden': 'true' }, icon), h('span', label))));
  app.views.history.refresh();
  const start = location.hash.slice(1) || 'record';
  app.go(start);
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v && v !== app.current) app.go(v); });
  if (app.record.restored) toast('前回の入力を戻しました。');
  firstRun();
  // 別のタブで記録が変わったら、履歴を読み直す
  window.addEventListener('storage', e => { if (e.key === S.KEYS.records) app.refresh(); });
  setupPwa();
}

// はじめて開いた時：ほかの版に記録があれば、引き継ぎを案内する
function firstRun() {
  let own = 0; try { own = S.readRecords().items.length; } catch { return; }
  if (own || S.readJSON('claude3:welcomed', false)) return;
  const found = S.OTHER_SOURCES.map(s => [s, S.readOtherSource(s.key)?.length || 0]).filter(([, n]) => n);
  S.writeJSON('claude3:welcomed', true);
  if (!found.length) return;
  const [src, n] = found[0];
  const bar = h('div.banner.welcome', h('span', `${src.label}に ${n}件の記録があります。`),
    h('button.btn.small.primary', { type: 'button', onclick: () => { bar.remove(); app.go('settings'); } }, '引き継ぐ'),
    h('button.btn.small.ghost', { type: 'button', onclick: () => bar.remove() }, 'あとで'));
  $('#main').prepend(bar);
}

// ---------------------------------------------------------------- PWA
let deferredInstall = null, swReg = null;
app.canInstall = () => !!deferredInstall;
app.install = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; app.views.settings.show(); };
app.checkUpdate = async () => {
  if (!swReg) return 'offline';
  try { await swReg.update(); } catch { return 'offline'; }
  await new Promise(r => setTimeout(r, 1200));
  app.updateState = swReg.waiting ? 'waiting' : 'none';
  return app.updateState;
};
app.applyUpdate = () => {
  if (app.record.isEditing()) { toast('編集中の記録を保存するか、やめてから更新してください。', 'error'); return; }
  swReg?.waiting?.postMessage({ type: 'ACTIVATE_UPDATE' });
};

function setupPwa() {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // 読み直すのは「更新」の時だけ。初めて開いた時（まだ Service Worker が付いていない）にも controllerchange が起きるので、それでは読み直さない
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.register('./sw.js', { scope: './' }).then(reg => {
    swReg = reg;
    const mark = () => { if (reg.waiting && navigator.serviceWorker.controller) { app.updateState = 'waiting'; app.views.settings.renderUpdate('waiting'); toast('新しい版があります。設定から更新できます。'); } };
    mark();
    reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', mark));
  }).catch(() => {});
}

boot();
