// 雪山の画面（ハイブリッド）：Claude のボットが毎時作る snow/latest.json を読み、
// チャッピー版のような「おすすめ・比べる・お気に入り」で見せる。スマホからは天気の API を呼ばない。
import { h, $, $$, toast, sheet, segmented, dayLabel } from './ui.js';
import * as S from './store.js';

const DATA_URL = '../snow/latest.json';
const STALE_H = 6;
const MAX_COMPARE = 3;

// WMO の天気コード → 絵と言葉
function wx(code) {
  if (code === null || code === undefined) return ['・', '不明'];
  if (code === 0) return ['☀️', '晴れ'];
  if (code <= 2) return ['🌤️', '晴れ間'];
  if (code === 3) return ['☁️', 'くもり'];
  if (code <= 48) return ['🌫️', '霧'];
  if (code <= 67) return ['🌧️', '雨'];
  if (code <= 77) return ['❄️', '雪'];
  if (code <= 82) return ['🌦️', 'にわか雨'];
  if (code <= 86) return ['🌨️', 'にわか雪'];
  return ['⛈️', '雷'];
}
const r0 = v => (v === null || v === undefined ? '—' : Math.round(v));
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

// 1日分の評価。注意（flags）は理由として見せる。outは「おすすめから外す」理由
export function evalDay(day) {
  const dd = day?.day || {};
  const med = day?.snow?.med ?? 0;
  const fresh = dd.snow_am !== null && dd.snow_am !== undefined ? (med + dd.snow_am) / 2 : med;
  const flags = [], out = [];
  if ((dd.rain ?? 0) >= 2) { out.push(`日中に雨 ${dd.rain}mm`); }
  if ((dd.gust ?? 0) >= 17) out.push(`突風 ${r0(dd.gust)}m/s（リフトが止まるかも）`);
  else if ((dd.gust ?? 0) >= 12 || (dd.wind ?? 0) >= 9) flags.push(`風が強め（最大 ${r0(dd.gust ?? dd.wind)}m/s）`);
  if ((dd.lowvis ?? 0) >= 3) flags.push('視界が悪い時間あり');
  if (day?.agree === '割れている') flags.push('予報が割れている');
  if (dd.tmax !== null && dd.tmax !== undefined && dd.tmax > 3) flags.push(`気温が高め（${r0(dd.tmax)}°C）`);
  const sun = dd.cloud === null || dd.cloud === undefined ? 0.4 : 1 - dd.cloud / 100;
  const calm = 1 - clamp(((dd.gust ?? 8) - 8) / 12);
  const snow = clamp(fresh / 25);
  return { fresh, sun, calm, snow, flags, out, dd, day };
}
const SCORE = {
  balance: e => 0.5 * e.snow + 0.3 * e.sun + 0.2 * e.calm,
  powder: e => 0.8 * e.snow + 0.2 * e.calm,
  sunny: e => 0.6 * e.sun + 0.3 * e.calm + 0.1 * e.snow,
};

export function createSnowView(app) {
  const root = h('section.view', { id: 'view-snow', 'aria-labelledby': 'snowTitle' });
  let data = null, loading = false, loadError = '';
  let when = 'weekend';
  let compare = new Set();
  let favs = new Set(S.readJSON(S.KEYS.snowFav, []));

  const status = h('p.snow-status', { 'aria-live': 'polite' });
  const dateRow = h('div.chip-row', { role: 'group', 'aria-label': '日付' });
  const modeSeg = segmented([['balance', 'バランス'], ['powder', '新雪重視'], ['sunny', '晴れ重視']], app.settings.snowMode, v => { app.setSetting({ snowMode: v }); render(); }, { allowEmpty: false, label: '何を重視するか' });
  const regionSel = h('select', { 'aria-label': '地域', onchange: () => { app.setSetting({ snowRegion: regionSel.value }); render(); } });
  const picks = h('div.picks');
  const list = h('div.spot-list');
  const compareBar = h('div.compare-bar', { hidden: true });

  root.append(
    h('header.view-head', h('h1', { id: 'snowTitle' }, '雪山'), h('button.btn.small.ghost', { type: 'button', onclick: () => load(true) }, '再読み込み')),
    status,
    h('div.snow-controls', dateRow, modeSeg, h('label.field.inline', h('span.field-label', '地域'), regionSel)),
    picks, list,
    h('p.hint.source', '予報：Open-Meteo（ECMWF・GFS のアンサンブルと6つのモデル）、気象庁（週間予報・アメダス実測）。毎時、Claude のボットがまとめています。営業状況は必ず公式で確かめてください。'),
    compareBar);

  async function load(force = false) {
    if (loading) return;
    if (data && !force) { render(); return; }
    loading = true; status.textContent = '読み込み中…';
    try {
      const res = await fetch(DATA_URL, { cache: force ? 'reload' : 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || json.version !== 1 || !Array.isArray(json.spots)) throw new Error('形式が違います');
      data = json; loadError = '';
    } catch (e) {
      loadError = navigator.onLine === false ? '通信できません。' : `データを読めませんでした（${e.message}）。`;
    } finally { loading = false; }
    render();
  }

  const ageHours = () => (data ? (Date.now() - Date.parse(data.made)) / 3600e3 : Infinity);
  const dates = () => (data?.spots.find(s => s.days?.length)?.days || []).map(d => d.date).filter(d => d >= todayJST());
  const weekendLabel = () => data?.spots.find(s => s.weekend_label)?.weekend_label || '';

  function evaluate(spot) {
    if (!spot.days?.length) return null;
    const pick = when === 'weekend' ? weekendDates(spot) : [when];
    const evals = pick.map(d => spot.days.find(x => x.date === d)).filter(Boolean).map(evalDay);
    if (!evals.length) return null;
    const score = evals.reduce((a, e) => a + SCORE[app.settings.snowMode](e), 0) / evals.length;
    const snowSum = when === 'weekend' ? spot.weekend : evals[0].day.snow;
    const flags = [...new Set(evals.flatMap(e => e.flags))];
    const out = [...new Set(evals.flatMap(e => e.out))];
    return { spot, score, evals, snowSum, flags, out };
  }
  function weekendDates(spot) {
    const all = spot.days.map(d => d.date);
    const first = all.find(d => d >= todayJST() && [0, 6].includes(new Date(d + 'T12:00:00+09:00').getDay()));
    if (!first) return [];
    const sat = new Date(first + 'T12:00:00+09:00').getDay() === 6;
    const next = new Date(Date.parse(first + 'T12:00:00+09:00') + 864e5).toISOString().slice(0, 10);
    return sat && all.includes(next) ? [first, next] : [first];
  }

  function render() {
    if (!data) {
      status.textContent = loadError || '読み込み中…';
      picks.replaceChildren(); list.replaceChildren(loadError ? h('div.empty', h('p', loadError), h('button.btn.small', { type: 'button', onclick: () => load(true) }, 'もう一度')) : '');
      return;
    }
    const age = ageHours();
    const stale = age > STALE_H;
    status.replaceChildren(
      `更新 ${new Date(data.made).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      data.observed ? ` · 実測 ${new Date(data.observed).getHours()}時` : ' · 実測なし',
      stale ? h('strong.warn', ` · ${Math.floor(age)}時間前のデータです。おすすめは出しません。`) : '');
    if (loadError) status.append(h('span.warn', ` · ${loadError}前回のデータを表示中`));

    // 日付
    const ds = dates();
    if (when !== 'weekend' && !ds.includes(when)) when = 'weekend';
    const opts = [['weekend', `今週末${weekendLabel() ? ` ${weekendLabel().replace(/\(.\)/g, '')}` : ''}`], ...ds.map(d => [d, dayLabel(d)])];
    dateRow.replaceChildren(...opts.map(([v, t]) => h('button.chip', { type: 'button', 'aria-pressed': String(v === when), onclick: () => { when = v; render(); } }, t)));
    // 地域
    const regions = [...new Set(data.spots.map(s => s.region))];
    regionSel.replaceChildren(h('option', { value: 'all' }, 'すべて'), h('option', { value: 'fav' }, `★ お気に入り（${favs.size}）`), regions.map(r => h('option', { value: r }, r)));
    regionSel.value = [...regions, 'all', 'fav'].includes(app.settings.snowRegion) ? app.settings.snowRegion : 'all';
    modeSeg.set(app.settings.snowMode);

    const reg = regionSel.value;
    const spots = data.spots.filter(s => reg === 'all' || (reg === 'fav' ? favs.has(s.id) : s.region === reg));
    const evals = spots.map(s => ({ s, e: evaluate(s) })).sort((a, b) => (b.e?.score ?? -1) - (a.e?.score ?? -1));

    // おすすめ（新しいデータの時だけ）
    const top = stale ? [] : evals.filter(x => x.e && !x.e.out.length).slice(0, 3);
    picks.replaceChildren(...(top.length ? [h('h2.section-title', `おすすめ（${when === 'weekend' ? '今週末' : dayLabel(when)}）`),
      h('div.pick-cards', top.map(({ s, e }, i) => pickCard(s, e, i))), h('p.hint', 'シーズン前や営業時間外のこともあります。行く前に公式の営業情報を確かめてください。')] :
      stale ? [] : [h('p.hint', 'この条件では、おすすめできる場所がありません（雨・強風など）。')]));
    if (reg === 'fav' && !favs.size) { list.replaceChildren(h('div.empty', h('p', 'まだお気に入りがありません。'), h('p.hint', '一覧の ☆ を押すと、ここにまとまります。'))); return; }
    list.replaceChildren(h('h2.section-title', '一覧'), ...evals.map(({ s, e }) => row(s, e)));
    renderCompareBar();
  }

  function snowText(sn) { return sn ? `${r0(sn.med)}cm` : '—'; }
  function rangeText(sn) { return sn && sn.p90 !== undefined ? `${r0(sn.p10)}〜${r0(sn.p90)}` : ''; }

  function pickCard(s, e, i) {
    const why = [];
    if (e.snowSum?.med >= 5) why.push('新雪が多い');
    const sunAvg = e.evals.reduce((a, x) => a + x.sun, 0) / e.evals.length;
    if (sunAvg >= 0.6) why.push('晴れ間が多い');
    if (e.evals.every(x => x.calm >= 0.8)) why.push('風が弱い');
    return h('button.pick', { type: 'button', onclick: () => openSpot(s) },
      h('span.rank', i + 1), h('span.pick-name', s.name), h('span.pick-region', s.region),
      h('span.pick-snow', snowText(e.snowSum), h('small', rangeText(e.snowSum) ? ` 幅 ${rangeText(e.snowSum)}` : '')),
      h('span.pick-why', why.join(' · ') || '大きな崩れなし'),
      e.flags.length ? h('span.pick-flag', e.flags.join(' · ')) : null);
  }

  function row(s, e) {
    const ev = e?.evals[0];
    const [icon, word] = wx(ev?.dd.code);
    const fav = favs.has(s.id);
    const checked = compare.has(s.id);
    return h('article.spot', { dataset: { id: s.id } },
      h('button.spot-main', { type: 'button', onclick: () => openSpot(s) },
        h('span.spot-name', s.name, h('small', s.region)),
        h('span.spot-wx', { title: word }, icon),
        h('span.spot-snow', e ? snowText(e.snowSum) : '—', h('small', e && rangeText(e.snowSum) ? rangeText(e.snowSum) : '')),
        h('span.spot-obs', s.obs ? `積雪 ${s.obs.depth ?? '—'}cm` : s.obs_failed ? '実測なし' : ''),
        e && (e.out.length || e.flags.length) ? h('span.spot-flags' + (e.out.length ? '.bad' : ''), [...e.out, ...e.flags].join(' · ')) : null,
        s.error ? h('span.spot-flags.bad', '予報を取れませんでした') : null),
      h('div.spot-actions',
        h('button.icon-btn', { type: 'button', 'aria-pressed': String(fav), 'aria-label': fav ? 'お気に入りから外す' : 'お気に入りにする', onclick: () => toggleFav(s.id) }, fav ? '★' : '☆'),
        h('label.compare-check', h('input', { type: 'checkbox', checked, onchange: ev2 => toggleCompare(s.id, ev2.target) }), '比べる')));
  }

  function toggleFav(id) {
    favs.has(id) ? favs.delete(id) : favs.add(id);
    S.writeJSON(S.KEYS.snowFav, [...favs]); render();
  }
  function toggleCompare(id, box) {
    if (box.checked && compare.size >= MAX_COMPARE) { box.checked = false; toast(`比べられるのは ${MAX_COMPARE} か所までです。`); return; }
    box.checked ? compare.add(id) : compare.delete(id);
    renderCompareBar();
  }
  function renderCompareBar() {
    compareBar.hidden = compare.size < 2;
    compareBar.replaceChildren(h('span', `${compare.size}か所を選択中`),
      h('button.btn.small.ghost', { type: 'button', onclick: () => { compare.clear(); render(); } }, '解除'),
      h('button.btn.small.primary', { type: 'button', onclick: openCompare }, '並べて比べる'));
  }

  function openCompare() {
    const spots = [...compare].map(id => data.spots.find(s => s.id === id)).filter(Boolean);
    const ds = dates().slice(0, 7);
    const table = h('table.compare-table',
      h('thead', h('tr', h('th', ''), spots.map(s => h('th', s.name)))),
      h('tbody',
        h('tr.week', h('th', '今週末'), spots.map(s => h('td', s.weekend ? `${r0(s.weekend.med)}cm` : '—', h('small', s.weekend ? ` ${r0(s.weekend.p10)}〜${r0(s.weekend.p90)}` : '')))),
        h('tr', h('th', '積雪（実測）'), spots.map(s => h('td', s.obs ? `${s.obs.depth ?? '—'}cm` : '—'))),
        ds.map(d => h('tr', h('th', dayLabel(d)), spots.map(s => {
          const day = s.days?.find(x => x.date === d); if (!day) return h('td', '—');
          const e = evalDay(day); const [icon] = wx(e.dd.code);
          return h('td' + (e.out.length ? '.bad' : ''), h('span.cell-wx', icon), ` ${r0(day.snow?.med)}cm`, h('small', ` 風${r0(e.dd.gust)}`));
        })))));
    sheet('並べて比べる', h('div.table-scroll', table, h('p.hint', 'cm は新雪の予報（アンサンブルの真ん中）。「風」は日中の最大瞬間風速 m/s。赤い日は雨か強風です。')), { wide: true });
  }

  function openSpot(s) {
    const days = s.days || [];
    const models = days.length ? Object.keys(days[0].models || {}) : [];
    const links = [
      s.official && ['公式サイト（営業・リフト）', s.official],
      ['ウェザーニュース', `https://weathernews.jp/onebox/${s.lat.toFixed(2)}/${s.lon.toFixed(2)}/`],
      ['Windy', `https://www.windy.com/${s.lat}/${s.lon}?${s.lat},${s.lon},11`],
      s.jma_office && ['気象庁の予報', `https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=${s.jma_office}`],
      ['Claude の雪山レポート', '../snow/'],
    ].filter(Boolean);
    const body = h('div.spot-detail',
      h('div.stat-tiles',
        h('div.tile', h('strong', s.weekend ? `${r0(s.weekend.med)}cm` : '—'), h('span', `今週末の新雪${s.weekend ? `（${r0(s.weekend.p10)}〜${r0(s.weekend.p90)}）` : ''}`)),
        h('div.tile', h('strong', s.week ? `${r0(s.week.med)}cm` : '—'), h('span', '7日間の新雪')),
        h('div.tile', h('strong', s.obs ? `${s.obs.depth ?? '—'}cm` : '—'), h('span', s.obs ? `積雪の実測（${s.obs.name}・${s.obs.km}km）` : '近くに観測点なし'))),
      h('h3', '日ごとの予報'),
      h('div.table-scroll', h('table.day-table',
        h('thead', h('tr', h('th', '日'), h('th', '天気'), h('th', '新雪'), h('th', '朝まで'), h('th', '風'), h('th', '気温'), h('th', '気象庁'))),
        h('tbody', days.map(day => {
          const e = evalDay(day); const [icon, word] = wx(e.dd.code); const j = day.jma;
          return h('tr' + (e.out.length ? '.bad' : ''),
            h('th', dayLabel(day.date)), h('td', { title: word }, icon),
            h('td', `${r0(day.snow?.med)}`, h('small', ` ${r0(day.snow?.p10)}〜${r0(day.snow?.p90)}`)),
            h('td', e.dd.snow_am !== undefined && e.dd.snow_am !== null ? r0(e.dd.snow_am) : '—'),
            h('td', e.dd.gust !== undefined ? `${r0(e.dd.gust)}` : '—'),
            h('td', `${r0(day.tmin)}〜${r0(day.tmax)}`),
            h('td.jma', j ? `${j.w}${j.pop ? ` ${j.pop}%` : ''}${j.rel ? `（${j.rel}）` : ''}` : '—'));
        })))),
      h('p.hint', '新雪は cm（真ん中の値と、ありそうな幅）。「朝まで」は前日9時〜当日9時の新雪。風は日中の最大瞬間風速 m/s。気象庁の（A/B/C）は予報の信頼度。'),
      models.length ? h('details.models', h('summary', '予報モデルどうしを比べる'),
        h('div.table-scroll', h('table.day-table', h('thead', h('tr', h('th', '日'), models.map(m => h('th', m)), h('th', 'そろい具合'))),
          h('tbody', days.map(day => h('tr', h('th', dayLabel(day.date)), models.map(m => h('td', r0(day.models?.[m]))), h('td', day.agree || '—'))))))) : null,
      h('h3', '道路の規制（チェーン規制・通行止め）'),
      h('ul.links.road', roadLinks(s).map(([t, u, note]) => h('li', h('a', { href: u, target: '_blank', rel: 'noopener' }, t), note ? h('small', ` ${note}`) : null))),
      h('p.hint', '規制は刻々と変わります。出発前と、途中の休憩でも確かめてください。冬用タイヤでも、チェーン規制の区間はチェーンが必要です。'),
      h('h3', 'もっと見る'),
      h('ul.links', links.map(([t, u]) => h('li', h('a', { href: u, target: '_blank', rel: 'noopener' }, t)))));
    sheet(s.name, body, { wide: true });
  }

  return { el: root, show: () => load(false), reload: () => load(true) };
}

// 道路の規制は、公式サイトへ案内する（チェーン規制・通行止めを配る公開 API はないため、アプリでは取得しない）。
// 一般道：国交省「道路情報提供システム」。利用条件で「リンクは原則トップページへ」「無断転載不可」なので、
// トップページへのリンクだけにし、内容の取得・転載はしない。
// 高速道路：地域ごとの NEXCO の交通情報（東日本＝ドラぷら、中日本・西日本＝アイハイウェイ）。
const NEXCO_EAST = ['ドラぷら（NEXCO東日本）', 'https://www.driveplaza.com/traffic/', '高速道路'];
const IHIGHWAY = ['アイハイウェイ（NEXCO中日本・西日本）', 'https://ihighway.jp/', '高速道路'];
const EXPRESSWAY = {
  北海道: [NEXCO_EAST], 東北: [NEXCO_EAST], 関東: [NEXCO_EAST], 新潟: [NEXCO_EAST],
  長野: [NEXCO_EAST, IHIGHWAY], 岐阜: [IHIGHWAY], 福井: [IHIGHWAY], 滋賀: [IHIGHWAY], 関西: [IHIGHWAY], 中国: [IHIGHWAY], 愛媛: [IHIGHWAY],
};
export function roadLinks(s) {
  return [
    ['道路情報提供システム（国土交通省）', 'https://www.road-info-prvs.mlit.go.jp/roadinfo/', '「通行規制」から地域を選ぶ。冬期通行止め・チェーン規制・雪の通行止め'],
    ...(EXPRESSWAY[s.region] || [NEXCO_EAST, IHIGHWAY]),
    ['日本道路交通情報センター（JARTIC）', 'https://www.jartic.or.jp/', '都道府県道を含む全国'],
  ];
}

function todayJST() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}
