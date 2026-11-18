# -*- coding: utf-8 -*-
"""雪山レポート: 気象庁の積雪の実測と、Open-Meteo のアンサンブル予報（ECMWF・GFS）から、スキー場ごとの HTML 報告を作る。
AI は使わない（数字はすべてこのプログラムが計算する）。
スタンスメモ用（Claude 試作）: python tools/yukiyama.py --out snow --back ../
  入力: snow/resorts.json
  出力: snow/index.html（最新）、snow/archive/日付.html、snow/data/日付.json（予報と実測の記録。当たり具合を後で調べるため）
"""
import argparse
import datetime as dt
import html
import json
import math
import statistics
import sys
import time
import urllib.request
from pathlib import Path

VERSION = "v00.02.00"
ARGS = argparse.ArgumentParser(description="雪山レポート")
ARGS.add_argument("--out", default="snow", help="resorts.json があり、報告を書き出すフォルダ")
ARGS.add_argument("--back", default="", help="戻るリンクの行き先（例 ../ でスタンスメモへ）")
OPT = ARGS.parse_args()
ROOT = Path(OPT.out).resolve()
SITE = ROOT
DATA = ROOT / "data"
JST = dt.timezone(dt.timedelta(hours=9))
UA = {"User-Agent": "yukiyama-report/0.1 (personal use)"}
MODELS = {"ecmwf_ifs025": ("ecmwf_ifs025_ensemble", "ECMWF"), "gfs025": ("ncep_gefs025", "GFS")}
WEEK = "月火水木金土日"


def get_json(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"  再試行 {i + 1}: {e}")
            time.sleep(5 * (i + 1))


# ---------------------------------------------------------------- 気象庁（実測）
def jma_observed():
    """積雪を測っているアメダスの、いまの積雪と24時間の増減"""
    latest = dt.datetime.fromisoformat(open_text("https://www.jma.go.jp/bosai/amedas/data/latest_time.txt").strip())
    now_map = get_json(f"https://www.jma.go.jp/bosai/amedas/data/map/{latest:%Y%m%d%H%M%S}.json")
    before = latest - dt.timedelta(hours=24)
    try:
        old_map = get_json(f"https://www.jma.go.jp/bosai/amedas/data/map/{before:%Y%m%d%H%M%S}.json")
    except Exception:  # noqa: BLE001
        old_map = {}
    table = get_json("https://www.jma.go.jp/bosai/amedas/const/amedastable.json")
    stations = []
    for sid, v in now_map.items():
        if "snow" not in v or sid not in table:
            continue
        t = table[sid]
        depth = v["snow"][0] if v["snow"] and v["snow"][1] == 0 else None
        old = old_map.get(sid, {}).get("snow")
        old_depth = old[0] if old and old[1] == 0 else None
        stations.append({"id": sid, "name": t["kjName"], "alt": t.get("alt"),
                         "lat": t["lat"][0] + t["lat"][1] / 60, "lon": t["lon"][0] + t["lon"][1] / 60,
                         "depth": depth, "change24": (depth - old_depth) if depth is not None and old_depth is not None else None})
    return latest, stations


def open_text(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read().decode("utf-8")


def km(a_lat, a_lon, b_lat, b_lon):
    p = math.pi / 180
    x = (b_lon - a_lon) * p * math.cos((a_lat + b_lat) / 2 * p)
    y = (b_lat - a_lat) * p
    return 6371 * math.hypot(x, y)


def nearest(resort, stations, limit_km=40):
    best = min(stations, key=lambda s: km(resort["lat"], resort["lon"], s["lat"], s["lon"]), default=None)
    if not best:
        return None
    d = km(resort["lat"], resort["lon"], best["lat"], best["lon"])
    return {**best, "km": round(d, 1)} if d <= limit_km else None


# ---------------------------------------------------------------- Open-Meteo（予報）
def forecast(resort, days=7):
    url = ("https://ensemble-api.open-meteo.com/v1/ensemble?"
           f"latitude={resort['lat']}&longitude={resort['lon']}&elevation={resort['elev']}"
           "&hourly=snowfall,temperature_2m&models=" + ",".join(MODELS) +
           f"&timezone=Asia%2FTokyo&forecast_days={days}")
    h = get_json(url)["hourly"]
    dates = sorted({t[:10] for t in h["time"]})
    out = {}
    for key, (suffix, label) in MODELS.items():
        snow_keys = [k for k in h if k.startswith("snowfall") and k.endswith(suffix)]
        temp_keys = [k for k in h if k.startswith("temperature_2m") and k.endswith(suffix)]
        per_day = {}
        for d in dates:
            idx = [i for i, t in enumerate(h["time"]) if t.startswith(d)]
            sums = []
            for k in snow_keys:
                vals = [h[k][i] for i in idx]
                if any(v is None for v in vals):
                    continue
                sums.append(sum(vals))
            highs, lows = [], []
            for k in temp_keys:
                vals = [h[k][i] for i in idx if h[k][i] is not None]
                if len(vals) == len(idx):
                    highs.append(max(vals))
                    lows.append(min(vals))
            if sums:
                per_day[d] = {"members": len(sums), "snow_med": q(sums, .5), "snow_p10": q(sums, .1), "snow_p90": q(sums, .9),
                              "tmax": q(highs, .5) if highs else None, "tmin": q(lows, .5) if lows else None, "sums": sums}
        out[label] = per_day
    return out


def q(values, p):
    v = sorted(values)
    if not v:
        return None
    k = (len(v) - 1) * p
    f, c = math.floor(k), math.ceil(k)
    return v[f] + (v[c] - v[f]) * (k - f)


def combine(fc, dates):
    """モデルごとのメンバーを合わせた、日ごとの中央値と幅。モデル同士の差も見る"""
    rows = []
    for d in dates:
        members, meds, tmax, tmin = [], [], [], []
        for label, per_day in fc.items():
            x = per_day.get(d)
            if not x:
                continue
            members += x["sums"]
            meds.append(x["snow_med"])
            if x["tmax"] is not None:
                tmax.append(x["tmax"])
                tmin.append(x["tmin"])
        if not members:
            continue
        rows.append({"date": d, "med": q(members, .5), "p10": q(members, .1), "p90": q(members, .9),
                     "model_gap": (max(meds) - min(meds)) if len(meds) > 1 else 0,
                     "tmax": statistics.mean(tmax) if tmax else None, "tmin": statistics.mean(tmin) if tmin else None,
                     "by_model": {label: round(per_day[d]["snow_med"], 1) for label, per_day in fc.items() if d in per_day}})
    return rows


def total(fc, dates):
    """期間の合計（メンバーごとに足してから中央値と幅を出す）"""
    members = []
    for per_day in fc.values():
        n = min((len(per_day[d]["sums"]) for d in dates if d in per_day), default=0)
        if n == 0 or any(d not in per_day for d in dates):
            continue
        for i in range(n):
            members.append(sum(per_day[d]["sums"][i] for d in dates))
    return {"med": q(members, .5), "p10": q(members, .1), "p90": q(members, .9)} if members else None


def quality(tmax):
    if tmax is None:
        return "—"
    if tmax <= -4:
        return "軽い雪（パウダー期待）"
    if tmax <= 0:
        return "ふつうの雪"
    if tmax <= 3:
        return "重めの雪"
    return "雨や湿った雪のおそれ"


def uncertain(t):
    return t and (t["p90"] - t["p10"]) > max(10, t["med"] * 1.2)


# ---------------------------------------------------------------- 報告
def fmt(v, unit="cm", dec=0):
    return "—" if v is None else f"{v:.{dec}f}{unit}".replace("-0" + unit, "0" + unit)


def daylabel(d):
    x = dt.date.fromisoformat(d)
    return f"{x.month}/{x.day}({WEEK[x.weekday()]})"


def build(results, obs_time, now):
    ranked = sorted([r for r in results if r.get("week")], key=lambda r: r["week"]["med"], reverse=True)
    weekend = sorted([r for r in results if r.get("weekend")], key=lambda r: (r["weekend"]["med"] + ((r.get("obs") or {}).get("depth") or 0) * 0.1), reverse=True)
    lines = []
    if ranked and ranked[0]["week"]["med"] >= 1:
        top = "、".join(f'{r["name"]}（{r["week"]["med"]:.0f}cm）' for r in ranked[:3] if r["week"]["med"] >= 1)
        lines.append(f"この7日でいちばん降りそうなのは {top}。")
    else:
        lines.append("この7日は、どこもまとまった雪の予報はありません。")
    heavy = [r for r in results if r.get("days") and r["days"][0]["med"] >= 15]
    if heavy:
        lines.append("今日は " + "、".join(r["name"] for r in heavy) + " でまとまった雪の予報。道路の情報も確かめてください。")
    if weekend and weekend[0]["weekend"]["med"] >= 3:
        lines.append(f'週末（{weekend[0]["weekend_label"]}）の新雪は {weekend[0]["name"]} が有力（{weekend[0]["weekend"]["med"]:.0f}cm 前後）。')
    unsure = [r["name"] for r in results if uncertain(r.get("week"))]
    if unsure:
        lines.append("予報の幅が大きく、まだ読みにくい所: " + "、".join(unsure[:6]) + "。")

    def rank_rows(items, key, label):
        out = []
        for i, r in enumerate(items[:5], 1):
            t = r[key]
            out.append(f'<tr><td>{i}</td><td><a href="#{html.escape(r["name"])}">{html.escape(r["name"])}</a><span class="sub"> {r["region"]}</span></td>'
                       f'<td class="num"><b>{t["med"]:.0f}</b><span class="sub"> ({t["p10"]:.0f}〜{t["p90"]:.0f})</span></td></tr>')
        return f'<table class="rank"><tr><th></th><th>スキー場</th><th class="num">{label}</th></tr>{"".join(out)}</table>'

    cards = []
    for region in dict.fromkeys(r["region"] for r in results):
        cards.append(f"<h2>{html.escape(region)}</h2>")
        for r in [x for x in results if x["region"] == region]:
            if r.get("error"):
                cards.append(f'<div class="card" id="{html.escape(r["name"])}"><h3>{html.escape(r["name"])}</h3><p class="warn">データを取れませんでした: {html.escape(r["error"])}</p></div>')
                continue
            o = r.get("obs")
            obs = (f'近くの観測点 {html.escape(o["name"])}（{o["km"]}km・標高{o["alt"]}m）: 積雪 <b>{fmt(o["depth"])}</b>'
                   + (f'（24時間で {o["change24"]:+.0f}cm）' if o.get("change24") is not None else "")) if o else "近く（40km以内）に積雪の観測点がありません"
            days = "".join(
                f'<tr><td>{daylabel(d["date"])}</td><td class="num"><b>{d["med"]:.0f}</b><span class="sub"> ({d["p10"]:.0f}〜{d["p90"]:.0f})</span></td>'
                f'<td class="num">{fmt(d["tmin"], "°", 0)} / {fmt(d["tmax"], "°", 0)}</td><td class="sub">{quality(d["tmax"]) if d["med"] >= 1 else ""}'
                f'{" ・モデル差あり" if d["model_gap"] >= 10 else ""}</td></tr>' for d in r["days"])
            w = r["week"]
            cards.append(
                f'<div class="card" id="{html.escape(r["name"])}"><h3>{html.escape(r["name"])} <span class="sub">標高{r["elev"]}mで計算</span></h3>'
                f'<p>{obs}</p><p>7日間の新雪: <b>{w["med"]:.0f}cm</b> <span class="sub">（{w["p10"]:.0f}〜{w["p90"]:.0f}cm）'
                f'{" ・予報の幅が大きい" if uncertain(w) else ""}</span></p>'
                f'<table><tr><th>日</th><th class="num">新雪 cm</th><th class="num">最低/最高</th><th>雪質の目安</th></tr>{days}</table></div>')

    return f"""<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>雪山レポート {now:%m/%d}</title><style>{CSS}</style></head><body><main>
{f'<p class="back"><a href="{html.escape(OPT.back)}">← スタンスメモに戻る</a></p>' if OPT.back else ""}
<h1>❄ 雪山レポート <small>{VERSION}</small></h1>
<p class="sub">作成 {now:%Y/%m/%d %H:%M} ・ 実測 {obs_time:%m/%d %H:%M} 時点 ・ <a href="archive/">過去の報告</a></p>
<div class="card summary"><h2>きょうのまとめ</h2>{"".join(f"<p>{html.escape(x)}</p>" for x in lines)}</div>
<h2>7日間の新雪ランキング</h2>{rank_rows(ranked, "week", "新雪 cm（幅）")}
{f'<h2>週末（{weekend[0]["weekend_label"]}）の新雪</h2>' + rank_rows(weekend, "weekend", "新雪 cm（幅）") if weekend else ""}
{"".join(cards)}
<div class="card note"><h2>読み方</h2>
<p>新雪は、ECMWF（ヨーロッパ）と GFS（アメリカ）の予報を、条件を少しずつ変えて合わせて約80通り計算した結果の<b>真ん中の値</b>です。かっこ内は、少なめ〜多めの幅（10%〜90%）。幅が大きい時は、まだ読みにくいという意味です。</p>
<p>予報はスキー場の位置と標高で計算しています。山の上と下では大きく違います。積雪の実測は、近くの気象庁アメダスの値で、ゲレンデの積雪ではありません。雪質は最高気温からの目安です。</p>
<p>出かける前は、スキー場の公式発表と道路情報を必ず確かめてください。</p></div>
<p class="src">データ: <a href="https://www.jma.go.jp/">気象庁</a>（アメダスの積雪）を加工して作成 ・ 予報: <a href="https://open-meteo.com/">Open-Meteo</a>（CC BY 4.0、ECMWF・NOAA のデータ）</p>
</main></body></html>"""


CSS = """:root{--bg:#f4f7fa;--panel:#fff;--text:#1d2630;--sub:#6a7682;--line:#dde4ea;--accent:#2b6cb0;--warn:#b7791f}
@media (prefers-color-scheme:dark){:root{--bg:#12171d;--panel:#1b222a;--text:#e6edf3;--sub:#93a1ae;--line:#2c3640;--accent:#63b3ed;--warn:#f6ad55}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif;line-height:1.6;font-size:15px}
main{max-width:820px;margin:0 auto;padding:16px 16px 60px}h1{font-size:22px;margin:6px 0 2px}h1 small{font-size:12px;color:var(--sub);font-weight:normal}
h2{font-size:18px;margin:26px 0 8px}h3{font-size:16px;margin:0 0 6px}a{color:var(--accent)}.sub{color:var(--sub);font-size:12.5px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0;overflow-x:auto}
.summary p{margin:4px 0}.summary h2,.note h2{margin-top:0}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:5px 6px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--sub);font-weight:normal;font-size:12.5px}.num{text-align:right}.rank{background:var(--panel);border:1px solid var(--line);border-radius:10px}
.src{color:var(--sub);font-size:12px}.back{margin:0 0 6px;font-size:14px}"""


def main():
    now = dt.datetime.now(JST)
    resorts = json.loads((ROOT / "resorts.json").read_text(encoding="utf-8"))["resorts"]
    print("気象庁の実測を取得…")
    try:
        obs_time, stations = jma_observed()
    except Exception as e:  # noqa: BLE001
        print(f"  気象庁の取得に失敗: {e}")
        obs_time, stations = now, []
    results = []
    for r in resorts:
        print(f"予報を取得: {r['name']}")
        item = dict(r)
        try:
            fc = forecast(r)
            dates = sorted(set().union(*[set(v) for v in fc.values()]))
            item["days"] = combine(fc, dates)
            item["week"] = total(fc, dates)
            sat = next((d for d in dates if dt.date.fromisoformat(d).weekday() == 5 and d > now.date().isoformat()), None)
            if sat:
                sun = (dt.date.fromisoformat(sat) + dt.timedelta(days=1)).isoformat()
                span = [d for d in (sat, sun) if d in dates]
                item["weekend"] = total(fc, span)
                item["weekend_label"] = "・".join(daylabel(d) for d in span)
        except Exception as e:  # noqa: BLE001
            item["error"] = str(e)[:200]
        item["obs"] = nearest(r, stations)
        results.append(item)
        time.sleep(1)   # 無料のサービスなので、ゆっくり取りに行く
    SITE.mkdir(exist_ok=True)
    (SITE / "archive").mkdir(exist_ok=True)
    DATA.mkdir(exist_ok=True)
    page = build(results, obs_time, now)
    (SITE / "index.html").write_text(page, encoding="utf-8")
    (SITE / "archive" / f"{now:%Y-%m-%d}.html").write_text(page.replace('href="archive/"', 'href="./"'), encoding="utf-8")
    archive_index()
    (DATA / f"{now:%Y-%m-%d_%H}.json").write_text(json.dumps({"made": now.isoformat(), "observed": obs_time.isoformat(), "resorts": results},
                                                          ensure_ascii=False, indent=1), encoding="utf-8")
    bad = [r["name"] for r in results if r.get("error")]
    print(f"できました: {SITE / 'index.html'}" + (f"（取れなかった所: {'、'.join(bad)}）" if bad else ""))
    return 1 if len(bad) == len(results) else 0


def archive_index():
    files = sorted((SITE / "archive").glob("20*.html"), reverse=True)
    links = "".join(f'<a class="card" style="display:block" href="{f.name}">{f.stem}</a>' for f in files)
    (SITE / "archive" / "index.html").write_text(
        f'<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>過去の雪山レポート</title><style>{CSS}</style></head><body><main><p><a href="../">← 最新</a></p><h1>過去の報告</h1>{links}</main></body></html>',
        encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
