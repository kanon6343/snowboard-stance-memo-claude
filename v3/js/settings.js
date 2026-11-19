// 設定：表示、バックアップと復元、ほかの版からの引き継ぎ、アプリの更新
import { h, toast, ask, sheet, segmented, download } from './ui.js';
import * as S from './store.js';

export const VERSION = '3.0.1';

export function createSettingsView(app) {
  const root = h('section.view', { id: 'view-settings', 'aria-labelledby': 'settingsTitle' });
  const themeSeg = segmented([['auto', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']], app.settings.theme, v => { app.setSetting({ theme: v }); app.applyTheme(); }, { allowEmpty: false, label: '色' });
  const dirSeg = segmented([['regular', 'レギュラー（左足が前）'], ['goofy', 'グーフィー（右足が前）']], app.settings.stanceDir, v => { app.setSetting({ stanceDir: v }); app.record.applyDir(); }, { allowEmpty: false, label: '前足' });
  const modeSeg = segmented([['simple', '簡易'], ['detail', '詳細']], app.settings.mode, v => app.setSetting({ mode: v }), { allowEmpty: false, label: '入力の細かさ' });
  const sources = h('div.sources');
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: () => readFile(fileInput.files[0]) });
  const updateBox = h('div.update-box');
  const installBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => app.install() }, 'ホーム画面に追加');

  root.append(
    h('header.view-head', h('h1', { id: 'settingsTitle' }, '設定')),
    h('section.card', h('h2', '表示'),
      h('div.field', h('span.field-label', '色'), themeSeg),
      h('div.field', h('span.field-label', '前足'), dirSeg, h('small.hint', '板の図と履歴で、前足を左（上）に、つま先側をスタンスに合わせて表示します。')),
      h('div.field', h('span.field-label', '記録する画面'), modeSeg, h('small.hint', '詳細にすると、板の形状・セットバック・ディスクのずらし・ヒールカップも記録できます。'))),
    h('section.card', h('h2', 'バックアップと復元'),
      h('p.hint', '記録はこの端末のブラウザーの中だけにあります。機種変更の前や、ときどき書き出しておくと安心です。'),
      h('div.btn-row', h('button.btn.primary', { type: 'button', onclick: exportAll }, 'バックアップを書き出す'), h('button.btn', { type: 'button', onclick: () => fileInput.click() }, 'ファイルから復元')),
      fileInput,
      h('p.hint', 'スタンスメモのどの版で書き出したファイルでも読めます。')),
    h('section.card', h('h2', 'ほかの版から引き継ぐ'),
      h('p.hint', '同じブラウザーにある、ほかの版の記録を読み込めます。元の版の記録はそのまま残ります。'), sources),
    h('section.card', h('h2', 'アプリ'),
      h('p', `スタンスメモ Claude 版 v${VERSION}`), updateBox, installBtn,
      h('p.hint', h('a', { href: '../' }, '前の Claude 版（v2.5）を開く'), ' · ', h('a', { href: '../snow/' }, '雪山レポート'))));

  function renderSources() {
    let own = 0; try { own = S.readRecords().items.length; } catch {}
    const rows = S.OTHER_SOURCES.map(src => {
      const items = S.readOtherSource(src.key);
      if (!items || !items.length) return null;
      return h('div.source-row', h('span', h('strong', src.label), h('small', ` ${items.length}件`)),
        h('button.btn.small', { type: 'button', onclick: () => importItems(items, src.label) }, '読み込む'));
    }).filter(Boolean);
    sources.replaceChildren(...(rows.length ? rows : [h('p.hint', 'このブラウザーには、ほかの版の記録は見つかりませんでした。')]), own ? h('p.hint', `今の記録：${own}件`) : '');
  }

  function exportAll() {
    let items; try { items = S.readRecords().items; } catch (e) { toast(e.message + ' 書き出していません。', 'error'); return; }
    if (!items.length) { toast('まだ記録がありません。'); return; }
    const d = new Date(), p = n => String(n).padStart(2, '0');
    download(`snowboard-stance-memo_v2_claude3_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.json`, JSON.stringify(S.backupPayload(items), null, 2));
    toast(`${items.length}件を書き出しました。`, 'success');
  }

  async function readFile(file) {
    fileInput.value = '';
    if (!file) return;
    if (file.size > 20e6) { toast('ファイルが大きすぎます。', 'error'); return; }
    let items;
    try { items = S.parseBackup(JSON.parse(await file.text())); } catch { items = null; }
    if (!items) { toast('スタンスメモのバックアップとして読めませんでした。', 'error'); return; }
    importItems(items, file.name, true);
  }

  async function importItems(incoming, label, allowReplace = false) {
    let snap; try { snap = S.readRecords(); } catch (e) { toast(e.message + ' 読み込みを中止しました。', 'error'); return; }
    const plan = S.planImport(snap.items, incoming);
    if (!incoming.length) { toast('記録が入っていません。'); return; }
    if (allowReplace && snap.items.length) {
      const choice = await chooseImport(label, incoming.length, plan, snap.items.length);
      if (!choice) return;
      if (choice === 'replace') {
        if (!(await ask('上書きの確認', `今の記録 ${snap.items.length}件を消して、ファイルの ${incoming.length}件に置きかえます。元に戻せません。先にバックアップを書き出しましたか？`, { ok: '上書きする', danger: true }))) return;
        return finish(S.writeRecords(snap.raw, S.sortByDate(incoming)), `${incoming.length}件で置きかえました。`);
      }
    } else if (!(await ask('読み込み', `「${label}」の ${incoming.length}件のうち、${plan.add.length}件を足します。${plan.skipped.length ? `\n同じ記録（同じ ID か同じ日時）の ${plan.skipped.length}件は足しません。` : ''}`, { ok: '足す' }))) return;
    if (!plan.add.length) { toast('足す記録はありませんでした（すべて同じ記録がありました）。'); return; }
    finish(S.writeRecords(snap.raw, S.sortByDate([...snap.items, ...plan.add])), `${plan.add.length}件を足しました。`);
  }
  function finish(res, msg) {
    if (!res.ok) { toast(res.reason === 'quota' ? '端末の空きが足りませんでした。' : '確認中に記録が変わりました。もう一度やってください。', 'error'); return; }
    toast(msg, 'success'); app.refresh(); renderSources();
  }
  function chooseImport(label, n, plan, own) {
    return new Promise(resolve => {
      let pick = null;
      const dlg = sheet('復元のしかた', h('div',
        h('p', `「${label}」に ${n}件あります。今の記録は ${own}件です。`),
        h('p.hint', `足す：同じ記録を除いた ${plan.add.length}件を足します（おすすめ）。`),
        h('p.hint', '上書き：今の記録を消して、ファイルの内容だけにします。')), {
        actions: [
          h('button.btn.ghost.danger-text', { type: 'button', onclick: () => { pick = 'replace'; dlg.close(); } }, '上書き'),
          h('button.btn.primary', { type: 'button', onclick: () => { pick = 'add'; dlg.close(); } }, `${plan.add.length}件を足す`),
        ],
        onClose: () => resolve(pick),
      });
    });
  }

  function renderUpdate(state) {
    updateBox.replaceChildren(
      state === 'waiting' ? h('div.banner', h('span', '新しい版があります。'), h('button.btn.small.primary', { type: 'button', onclick: () => app.applyUpdate() }, '更新する')) :
      h('button.btn.small.ghost', { type: 'button', onclick: async () => { const r = await app.checkUpdate(); toast(r === 'waiting' ? '新しい版があります。' : r === 'none' ? '最新の版です。' : 'オフラインのため確認できません。'); renderUpdate(r); } }, '最新版を確認'));
  }

  return {
    el: root,
    show() { themeSeg.set(app.settings.theme); dirSeg.set(app.settings.stanceDir); modeSeg.set(app.settings.mode); renderSources(); renderUpdate(app.updateState); installBtn.hidden = !app.canInstall(); },
    renderUpdate,
  };
}
