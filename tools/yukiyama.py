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
import re
import statistics
import sys
import time
import urllib.request
from pathlib import Path

VERSION = "v00.04.00"
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
# 予報モデルどうしの比べ（Open-Meteo の通常の予報。各国の気象機関のモデル）
CMP_MODELS = [("気象庁", "jma_seamless"), ("欧州", "ecmwf_ifs025"), ("米国", "gfs_seamless"),
              ("独", "icon_seamless"), ("加", "gem_seamless"), ("仏", "meteofrance_seamless")]
RECORD_HOURS = (5, 11, 17, 23)   # 予報の記録（data/*.json）を残す時刻。ページは毎時作り直す
WEEK = "月火水木金土日"
TOOLS = Path(__file__).resolve().parent
TELOPS = json.loads((TOOLS / "jma_weather_codes.json").read_text(encoding="utf-8"))["codes"]


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
    # 積雪は毎正時にしか入らない（10分ごとの地図には snow が無いことがある）。積雪の入った時刻まで戻って探す
    cand = [latest] + [latest.replace(minute=0, second=0) - dt.timedelta(hours=h) for h in range(0, 7)]
    now_map = None
    for t in dict.fromkeys(cand):
        try:
            m = get_json(f"https://www.jma.go.jp/bosai/amedas/data/map/{t:%Y%m%d%H%M%S}.json", tries=2)
        except Exception:  # noqa: BLE001
            continue
        if sum(1 for v in m.values() if "snow" in v) >= 50:
            latest, now_map = t, m
            break
    if now_map is None:
        raise RuntimeError("積雪の入った観測時刻が見つかりません（最新から6時間）")
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
            sums = {}   # メンバー名 → その日の合計（欠測の日があっても、期間合計で別メンバーと混ざらないよう名前で持つ）
            for k in snow_keys:
                vals = [h[k][i] for i in idx]
                if not vals or any(v is None for v in vals):
                    continue
                sums[k] = sum(vals)
            highs, lows = [], []
            for k in temp_keys:
                vals = [h[k][i] for i in idx if h[k][i] is not None]
                if len(vals) == len(idx):
                    highs.append(max(vals))
                    lows.append(min(vals))
            if sums:
                v = list(sums.values())
                per_day[d] = {"members": len(v), "snow_med": q(v, .5), "snow_p10": q(v, .1), "snow_p90": q(v, .9),
                              "tmax": q(highs, .5) if highs else None, "tmin": q(lows, .5) if lows else None, "sums": sums}
        out[label] = per_day
    return out


def compare_models(resort, days=7):
    """各国の予報モデルの、日ごとの新雪（cm）。{日付: {モデル名: 値 or None}}"""
    url = ("https://api.open-meteo.com/v1/forecast?"
           f"latitude={resort['lat']}&longitude={resort['lon']}&elevation={resort['elev']}"
           "&daily=snowfall_sum&models=" + ",".join(m for _, m in CMP_MODELS) +
           f"&timezone=Asia%2FTokyo&forecast_days={days}")
    d = get_json(url, tries=2)["daily"]
    out = {}
    for i, day in enumerate(d["time"]):
        row = {}
        for label, m in CMP_MODELS:
            vals = d.get(f"snowfall_sum_{m}") or []
            row[label] = vals[i] if i < len(vals) else None
        out[day] = row
    return out


def agreement(vals):
    """モデルどうしのそろい具合（値がそろっていれば当たりやすい）"""
    v = [x for x in vals if x is not None]
    if len(v) < 3:
        return ""
    if max(v) < 1:
        return ""
    m = statistics.median(v)
    near = sum(1 for x in v if abs(x - m) <= max(3, m * 0.4)) / len(v)   # 真ん中の値の近くにいるモデルの割合（1つだけ外れても割れ扱いにしない）
    if near >= 0.8:
        return "そろう"
    if near >= 0.5:
        return "ややばらつき"
    return "割れている"


def jma_week(offices):
    """気象庁の週間天気予報。{(府県, 地域): {"area", "city", "days": {日付: {...}}}}"""
    out = {}
    for office in dict.fromkeys(offices):
        try:
            w = get_json(f"https://www.jma.go.jp/bosai/forecast/data/forecast/{office}.json", tries=2)[1]
        except Exception as e:  # noqa: BLE001
            print(f"  週間天気予報を取れず {office}: {e}")
            continue
        ts = w["timeSeries"]
        for i, a in enumerate(ts[0]["areas"]):
            t = ts[1]["areas"][i] if i < len(ts[1]["areas"]) else {}
            days = {}
            for j, when in enumerate(ts[0]["timeDefines"]):
                def pick(arr, k=j):
                    return (arr[k] if k < len(arr) else "") or ""
                code = pick(a.get("weatherCodes", []))
                days[when[:10]] = {"w": TELOPS.get(code, code), "code": code, "pop": pick(a.get("pops", [])),
                                   "rel": pick(a.get("reliabilities", [])),
                                   "tmin": pick(t.get("tempsMin", [])), "tmax": pick(t.get("tempsMax", []))}
            out[(office, a["area"]["code"])] = {"area": a["area"]["name"], "city": t.get("area", {}).get("name", ""),
                                                "office": w.get("publishingOffice", ""), "report": w.get("reportDatetime", ""), "days": days}
    return out


def wicon(code):
    return {"1": "☀", "2": "☁", "3": "☂", "4": "❄"}.get(str(code)[:1], "")


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
            members += list(x["sums"].values())
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
        if not dates or any(d not in per_day for d in dates):
            continue
        keys = set.intersection(*[set(per_day[d]["sums"]) for d in dates])   # 全日そろっているメンバーだけ
        for k in sorted(keys):
            members.append(sum(per_day[d]["sums"][k] for d in dates))
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


def more_sections(r):
    """開いた中に足す: 予報モデルの比べ・気象庁の週間天気・ほかの天気予報へのリンク"""
    out = []
    cmp_ = r.get("cmp")
    if cmp_:
        head = "".join(f'<th class="num">{html.escape(l)}</th>' for l, _ in CMP_MODELS)
        body = ""
        for d, row in sorted(cmp_.items()):
            vals = [row.get(l) for l, _ in CMP_MODELS]
            ag = agreement(vals)
            cls = {"そろう": "ok", "割れている": "warn"}.get(ag, "sub")
            mark = {"そろう": "◎", "ややばらつき": "○", "割れている": "△"}.get(ag, "")
            body += (f'<tr><td>{daylabel(d)}</td>' + "".join(f'<td class="num">{fmt(v, "")}</td>' for v in vals)
                     + f'<td class="{cls}" title="{ag}">{mark}</td></tr>')
        out.append(f'<h3 class="mh">予報モデルどうしの比べ（新雪 cm）</h3><div class="tbl"><table class="cmp"><tr><th>日</th>{head}<th></th></tr>{body}</table></div>'
                   '<p class="sub">気象庁・欧州・米国・独（ドイツ）・加（カナダ）・仏（フランス）の予報を同じ地点・標高で。◎ そろう（当たりやすい）、○ ややばらつき、△ 割れている（まだ読めない）。</p>')
    elif r.get("cmp_error"):
        out.append(f'<p class="sub warn">予報モデルの比べは取得できませんでした。</p>')
    wk = r.get("jma_week")
    if wk:
        rows = ""
        for d, x in sorted(wk["days"].items()):
            t = (f'{x["tmin"] or "—"} / {x["tmax"] or "—"}°') if (x["tmin"] or x["tmax"]) else "—"
            rows += (f'<tr><td>{daylabel(d)}</td><td>{wicon(x["code"])} {html.escape(x["w"])}</td>'
                     f'<td class="num">{html.escape(x["pop"]) + "%" if x["pop"] else "—"}</td><td class="num">{html.escape(x["rel"]) or "—"}</td>'
                     f'<td class="num">{html.escape(t)}</td></tr>')
        out.append(f'<h3 class="mh">気象庁の週間天気予報（{html.escape(wk["area"])}）</h3>'
                   f'<div class="tbl"><table><tr><th>日</th><th>天気</th><th class="num">降水</th><th class="num">信頼</th><th class="num">気温</th></tr>{rows}</table></div>'
                   f'<p class="sub">地域全体の予報で、気温は{html.escape(wk["city"])}（ふもとの街）の最低/最高です。信頼度は A（高い）〜C（低い）。</p>')
    lat, lon = r["lat"], r["lon"]
    links = [("ウェザーニュース", f"https://weathernews.jp/onebox/{lat:.2f}/{lon:.2f}/"),
             ("Windy", f"https://www.windy.com/{lat:.3f}/{lon:.3f}?{lat:.3f},{lon:.3f},11"),
             ("気象庁", f"https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code={r.get('jma_office', '')}" if r.get("jma_office") else "https://www.jma.go.jp/bosai/forecast/")]
    out.append('<p class="links">ほかの予報で見る: ' + " ・ ".join(
        f'<a href="{html.escape(u)}" target="_blank" rel="noopener">{html.escape(n)}</a>' for n, u in links) + "</p>")
    return "".join(out)


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

    sid = {r["name"]: f"s{i}" for i, r in enumerate(results)}   # スキー場ごとの飛び先（英数字の ID）
    regions = list(dict.fromkeys(r["region"] for r in results))
    rid = {g: f"r{i}" for i, g in enumerate(regions)}

    def rank_rows(items, key, label):
        out = []
        for i, r in enumerate(items[:5], 1):
            t = r[key]
            out.append(f'<tr><td>{i}</td><td><a class="jump" href="#{sid[r["name"]]}">{html.escape(r["name"])}</a><span class="sub"> {html.escape(r["region"])}</span></td>'
                       f'<td class="num"><b>{t["med"]:.0f}</b><span class="sub"> ({t["p10"]:.0f}〜{t["p90"]:.0f})</span></td></tr>')
        return f'<div class="tbl"><table class="rank"><tr><th></th><th>スキー場</th><th class="num">{label}</th></tr>{"".join(out)}</table></div>'

    sections = []
    for region in regions:
        rows = []
        for r in [x for x in results if x["region"] == region]:
            name = html.escape(r["name"])
            if r.get("error"):
                rows.append(f'<details class="spot" id="{sid[r["name"]]}" data-name="{name}"><summary><span class="nm">{name}</span>'
                            f'<span class="warn">取得できず</span></summary><p class="warn">データを取れませんでした: {html.escape(r["error"])}</p></details>')
                continue
            o = r.get("obs")
            if r.get("obs_failed"):
                obs = '<span class="warn">気象庁の実測を取得できませんでした（次の更新で再取得します）</span>'
            elif o:
                obs = (f'近くの観測点 {html.escape(o["name"])}（{o["km"]}km・標高{o["alt"]}m）: 積雪 <b>{fmt(o["depth"])}</b>'
                       + (f'（24時間で {o["change24"]:+.0f}cm）' if o.get("change24") is not None else ""))
            else:
                obs = "近く（40km以内）に積雪の観測点がありません"
            days = "".join(
                f'<tr><td>{daylabel(d["date"])}</td><td class="num"><b>{d["med"]:.0f}</b><span class="sub"> ({d["p10"]:.0f}〜{d["p90"]:.0f})</span></td>'
                f'<td class="num">{fmt(d["tmin"], "°", 0)} / {fmt(d["tmax"], "°", 0)}</td><td class="sub">{quality(d["tmax"]) if d["med"] >= 1 else ""}'
                f'{" ・モデル差あり" if d["model_gap"] >= 10 else ""}</td></tr>' for d in r["days"])
            w, we = r["week"], r.get("weekend")
            extra = more_sections(r)
            depth = fmt(o["depth"]) if o else "—"
            flag = '<span class="pill">読みにくい</span>' if uncertain(w) else ""
            rows.append(
                f'<details class="spot" id="{sid[r["name"]]}" data-name="{name}" data-week="{w["med"]:.0f}" data-weekend="{(we or {}).get("med", 0) or 0:.0f}" data-depth="{html.escape(depth)}">'
                f'<summary><span class="nm">{name}{flag}</span>'
                f'<span class="v"><b>{w["med"]:.0f}</b><small>cm</small><span class="sub">7日</span></span>'
                f'<span class="v2 sub">週末 {(we or {}).get("med", 0) or 0:.0f}cm ・ 積雪 {html.escape(depth)}</span></summary>'
                f'<div class="more"><p class="sub">標高{r["elev"]}mで計算 ・ 7日の幅 {w["p10"]:.0f}〜{w["p90"]:.0f}cm</p><p>{obs}</p>'
                f'<div class="tbl"><table><tr><th>日</th><th class="num">新雪 cm</th><th class="num">最低/最高</th><th>雪質の目安</th></tr>{days}</table></div>{extra}'
                f'<button type="button" class="fav" data-id="{sid[r["name"]]}" aria-pressed="false">☆ お気に入りに追加</button></div></details>')
        sections.append(f'<section class="region" id="{rid[region]}"><h2>{html.escape(region)}</h2>{"".join(rows)}</section>')

    chips = ['<a href="#top">まとめ</a>', '<a href="#fav">★</a>'] + [f'<a href="#{rid[g]}">{html.escape(g)}</a>' for g in regions]

    return f"""<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>雪山レポート {now:%m/%d}</title><style>{CSS}</style></head><body>
<nav class="chips" aria-label="地域へ移動"><div class="chips-in">{"".join(chips)}</div></nav>
<main>
<section id="top">
{f'<p class="back"><a href="{html.escape(OPT.back)}">← スタンスメモに戻る</a></p>' if OPT.back else ""}
<h1>❄ 雪山レポート <small>{VERSION}</small></h1>
<p class="sub">作成 {now:%Y/%m/%d %H:%M} ・ {f"実測 {obs_time:%m/%d %H:%M} 時点" if obs_time else '<span class="warn">実測は取得できず</span>'} ・ <a href="archive/">過去の報告</a></p>
<div class="card summary"><h2>きょうのまとめ</h2>{"".join(f"<p>{html.escape(x)}</p>" for x in lines)}</div>
</section>
<section id="fav"><h2>★ お気に入り</h2><div id="favList"><p class="sub">スキー場を開いて「☆ お気に入りに追加」を押すと、ここに並びます（この端末に保存）。</p></div></section>
<h2>7日間の新雪ランキング</h2>{rank_rows(ranked, "week", "新雪 cm（幅）")}
{f'<h2>週末（{weekend[0]["weekend_label"]}）の新雪</h2>' + rank_rows(weekend, "weekend", "新雪 cm（幅）") if weekend else ""}
<p class="sub">各スキー場の行を押すと、日ごとの予報が開きます。</p>
{"".join(sections)}
<div class="card note"><h2>読み方</h2>
<p>新雪は、ECMWF（ヨーロッパ）と GFS（アメリカ）の予報を、条件を少しずつ変えて合わせて約80通り計算した結果の<b>真ん中の値</b>です。かっこ内は、少なめ〜多めの幅（10%〜90%）。幅が大きい時は、まだ読みにくいという意味です。</p>
<p>予報はスキー場の位置と標高で計算しています。山の上と下では大きく違います。積雪の実測は、近くの気象庁アメダスの値で、ゲレンデの積雪ではありません。雪質は最高気温からの目安です。</p>
<p>各スキー場を開くと、各国の予報モデルの比べ、気象庁の週間天気予報、ウェザーニュースなどへのリンクもあります。</p>
<p>出かける前は、スキー場の公式発表と道路情報を必ず確かめてください。</p></div>
<p class="src">データ: <a href="https://www.jma.go.jp/">気象庁</a>（アメダスの積雪・週間天気予報）を加工して作成 ・ 予報: <a href="https://open-meteo.com/">Open-Meteo</a>（CC BY 4.0、気象庁・ECMWF・NOAA・DWD・カナダ気象局・Météo-France のデータ） ・ 毎時更新</p>
</main><script>{JS}</script></body></html>"""


CSS = """:root{--bg:#f4f7fa;--panel:#fff;--text:#1d2630;--sub:#6a7682;--line:#dde4ea;--accent:#2b6cb0;--warn:#b7791f}
@media (prefers-color-scheme:dark){:root{--bg:#12171d;--panel:#1b222a;--text:#e6edf3;--sub:#93a1ae;--line:#2c3640;--accent:#63b3ed;--warn:#f6ad55}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif;line-height:1.6;font-size:15px}
main{max-width:820px;margin:0 auto;padding:16px 16px 60px}h1{font-size:22px;margin:6px 0 2px}h1 small{font-size:12px;color:var(--sub);font-weight:normal}
h2{font-size:18px;margin:26px 0 8px}h3{font-size:16px;margin:0 0 6px}a{color:var(--accent)}.sub{color:var(--sub);font-size:12.5px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0;overflow-x:auto}
.summary p{margin:4px 0}.summary h2,.note h2{margin-top:0}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:5px 6px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--sub);font-weight:normal;font-size:12.5px}.num{text-align:right}.rank{background:var(--panel);border:1px solid var(--line);border-radius:10px}
.src{color:var(--sub);font-size:12px}.back{margin:0 0 6px;font-size:14px}
.chips{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line)}
.chips-in{max-width:820px;margin:0 auto;display:flex;gap:6px;overflow-x:auto;padding:8px 16px;scrollbar-width:none}
.chips-in::-webkit-scrollbar{display:none}
.chips a{flex:none;text-decoration:none;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:5px 13px;font-size:14px;white-space:nowrap}
.chips a.on{background:var(--accent);border-color:var(--accent);color:var(--bg)}
section[id],details.spot{scroll-margin-top:56px}
.tbl{overflow-x:auto}
.spot{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:8px 0}
.spot summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:10px 14px;align-items:center}
.spot summary::-webkit-details-marker{display:none}
.spot summary .nm{font-weight:600;min-width:0}
.spot summary .v{text-align:right;white-space:nowrap}.spot summary .v b{font-size:20px}.spot summary .v small{margin-left:1px}.spot summary .v .sub{margin-left:6px}
.spot summary .v2{grid-column:1/-1}
.spot[open] summary{border-bottom:1px solid var(--line)}
.spot .more{padding:8px 14px 12px}.spot .more p{margin:4px 0 8px}
.pill{display:inline-block;margin-left:6px;font-size:11px;font-weight:normal;color:var(--warn);border:1px solid var(--warn);border-radius:999px;padding:0 6px;vertical-align:2px}
.fav{margin-top:10px;font:inherit;font-size:14px;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
.fav[aria-pressed="true"]{border-color:var(--warn);color:var(--warn)}
.favrow{display:flex;justify-content:space-between;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0;text-decoration:none;color:var(--text)}
.favrow b{font-size:18px}
.mh{font-size:14px;margin:14px 0 4px}.ok{color:var(--accent)}.cmp td,.cmp th{padding:5px 4px}.mh+.tbl td{font-size:13.5px}
.links{font-size:14px;margin-top:12px!important}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}"""

JS = """(function(){
var KEY='claude:snow-favs-v1',favs=[];
try{favs=JSON.parse(localStorage.getItem(KEY)||'[]')||[]}catch(e){favs=[]}
function save(){try{localStorage.setItem(KEY,JSON.stringify(favs))}catch(e){}}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function drawFavs(){
  var box=document.getElementById('favList'),rows=[];
  favs.forEach(function(id){var d=document.getElementById(id);if(!d)return;
    rows.push('<a class="favrow jump" href="#'+id+'"><span>'+esc(d.dataset.name)+'<br><span class="sub">週末 '+esc(d.dataset.weekend||'0')+'cm ・ 積雪 '+esc(d.dataset.depth||'—')+'</span></span><span><b>'+esc(d.dataset.week||'—')+'</b>cm <span class="sub">7日</span></span></a>')});
  if(rows.length)box.innerHTML=rows.join('');
  document.querySelectorAll('.fav').forEach(function(b){var on=favs.indexOf(b.dataset.id)>=0;b.setAttribute('aria-pressed',on);b.textContent=on?'★ お気に入りから外す':'☆ お気に入りに追加'});
}
document.addEventListener('click',function(e){
  var b=e.target.closest('.fav');
  if(b){var i=favs.indexOf(b.dataset.id);if(i>=0)favs.splice(i,1);else favs.push(b.dataset.id);save();
    if(!favs.length)document.getElementById('favList').innerHTML='<p class="sub">スキー場を開いて「☆ お気に入りに追加」を押すと、ここに並びます（この端末に保存）。</p>';drawFavs();return}
  var a=e.target.closest('a.jump');
  if(a){var d=document.getElementById(a.getAttribute('href').slice(1));if(d&&d.tagName==='DETAILS')d.open=true}
});
function openHash(){var d=location.hash&&document.getElementById(location.hash.slice(1));if(d&&d.tagName==='DETAILS'){d.open=true;d.scrollIntoView()}}
window.addEventListener('hashchange',openHash);openHash();
drawFavs();
var chips=[].slice.call(document.querySelectorAll('.chips a')),secs=chips.map(function(a){return document.getElementById(a.getAttribute('href').slice(1))});
function mark(){var y=70,cur=0;secs.forEach(function(s,i){if(s&&s.getBoundingClientRect().top<=y)cur=i});
  chips.forEach(function(a,i){a.classList.toggle('on',i===cur)});
  var on=chips[cur];if(on&&on.parentNode.scrollTo){var p=on.parentNode;var x=on.offsetLeft-p.clientWidth/2+on.clientWidth/2;p.scrollTo({left:x})}}
var t;window.addEventListener('scroll',function(){clearTimeout(t);t=setTimeout(mark,60)},{passive:true});mark();
})();"""


def main():
    now = dt.datetime.now(JST)
    resorts = json.loads((ROOT / "resorts.json").read_text(encoding="utf-8"))["resorts"]
    print("気象庁の実測を取得…")
    try:
        obs_time, stations = jma_observed()
    except Exception as e:  # noqa: BLE001
        print(f"  気象庁の取得に失敗: {e}")
        obs_time, stations = None, None   # 「観測点なし」と区別する
    print("気象庁の週間天気予報を取得…")
    weekly = jma_week([r["jma_office"] for r in resorts if r.get("jma_office")])
    results = []
    for r in resorts:
        print(f"予報を取得: {r['name']}")
        item = dict(r)
        item["jma_week"] = weekly.get((r.get("jma_office"), r.get("jma_week_area")))
        try:
            item["cmp"] = compare_models(r)
        except Exception as e:  # noqa: BLE001
            item["cmp_error"] = str(e)[:200]
            print(f"  予報モデルの比べを取れず: {e}")
        try:
            fc = forecast(r)
            dates = sorted(set().union(*[set(v) for v in fc.values()]))
            item["days"] = combine(fc, dates)
            item["week"] = total(fc, dates)
            if not item["week"] or not item["days"]:
                raise RuntimeError("有効な予報がありませんでした")
            # 今日が土・日ならその週末（日曜なら日曜だけ）、平日なら次の土日
            first = next((d for d in dates if d >= now.date().isoformat() and dt.date.fromisoformat(d).weekday() >= 5), None)
            if first:
                span = [first] + ([(dt.date.fromisoformat(first) + dt.timedelta(days=1)).isoformat()]
                                  if dt.date.fromisoformat(first).weekday() == 5 else [])
                span = [d for d in span if d in dates]
                item["weekend"] = total(fc, span)
                item["weekend_label"] = "・".join(daylabel(d) for d in span)
        except Exception as e:  # noqa: BLE001
            item["error"] = str(e)[:200]
            item.pop("week", None)
            item.pop("weekend", None)
        item["obs"] = nearest(r, stations) if stations is not None else None
        item["obs_failed"] = stations is None
        results.append(item)
        time.sleep(1)   # 無料のサービスなので、ゆっくり取りに行く
    SITE.mkdir(exist_ok=True)
    (SITE / "archive").mkdir(exist_ok=True)
    DATA.mkdir(exist_ok=True)
    page = build(results, obs_time, now)
    (SITE / "index.html").write_text(page, encoding="utf-8")
    old = page.replace('href="archive/"', 'href="./"')   # 過去の報告ページは1段深いので、戻る先もずらす
    if OPT.back and not re.match(r"^(/|[a-z]+:)", OPT.back):
        old = old.replace(f'<p class="back"><a href="{html.escape(OPT.back)}">', f'<p class="back"><a href="../{html.escape(OPT.back)}">', 1)
    (SITE / "archive" / f"{now:%Y-%m-%d}.html").write_text(old, encoding="utf-8")
    archive_index()
    # 予報の記録は 5・11・17・23時の枠ごとに1つだけ（毎時動いても増えすぎないように。遅れて動いても枠の最初の1回で残す）
    slot = max(now.replace(hour=h, minute=0, second=0, microsecond=0) - dt.timedelta(days=d)
               for h in RECORD_HOURS for d in (0, 1)
               if now.replace(hour=h, minute=0, second=0, microsecond=0) - dt.timedelta(days=d) <= now)
    rec = DATA / f"{slot:%Y-%m-%d_%H}.json"
    if not rec.exists():
        rec.write_text(json.dumps({"made": now.isoformat(), "observed": obs_time.isoformat() if obs_time else None, "resorts": results},
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
