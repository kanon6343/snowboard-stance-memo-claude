"""道路の注意の「AI 版」。snow/latest.json のルール版の事実を、小さな AI（GitHub Actions の中で動く Ollama）で短い文章にする。

- 規制情報（通行止め・チェーン規制の実況）は扱わない。気象庁の警報・注意報と予報から作った事実だけを渡す。
- AI には事実の外のことを書かせない。書いた文は機械的に確かめ、だめなら捨てる（アプリはルール版だけを出す）。
- 出力：snow/road_ai.json

使い方：python -B tools/road_ai.py --data snow/latest.json --out snow/road_ai.json [--model qwen2.5:3b] [--host http://127.0.0.1:11434]
"""
import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

VERSION = "v00.02.00"
AP = argparse.ArgumentParser()
AP.add_argument("--data", default="snow/latest.json")
AP.add_argument("--out", default="snow/road_ai.json")
AP.add_argument("--model", default="qwen2.5:3b")
AP.add_argument("--host", default="http://127.0.0.1:11434")
AP.add_argument("--limit", type=int, default=0, help="試験用：最初の n 地点だけ")
OPT = AP.parse_args()
JST = dt.timezone(dt.timedelta(hours=9))
WEEK = "月火水木金土日"

SYSTEM = """あなたは、スキー場へ車で向かう人に「道路の注意」を短く伝える係です。
守ること：
- 与えられた「事実」だけを使う。事実にない数字・地名・道路名・規制（通行止め、チェーン規制が出ている等）を書かない。
- 日本語で、2文以内、全体で90文字以内。やさしい言葉で。
- 危ない日がある時は、その日を先に書く。何もない時は「大きな崩れはなさそう。冬用タイヤで、出発前に道路情報を確認」の意味のことを書く。
- 最後に、必要なら持ち物や行動を1つだけ（例：チェーンを持つ、時間に余裕を持つ）。
- 前置き・見出し・箇条書き・絵文字は書かない。文章だけを返す。"""

# 危険・天気の言葉 → 事実の中にあるべき根拠の言葉（どれか1つ）
HAZARDS = {
    "大雪": ["大雪", "新雪"], "豪雪": ["大雪"], "新雪": ["新雪"], "圧雪": ["圧雪", "新雪"], "積雪": ["新雪", "大雪"],
    "立ち往生": ["立ち往生"], "除雪": ["除雪"], "チェーン規制": ["チェーン規制"],
    "吹雪": ["風雪", "暴風雪"], "吹きだまり": ["吹きだまり"], "視界": ["視界", "濃霧"], "霧": ["濃霧", "視界"],
    "凍結": ["凍結", "冷える"], "アイスバーン": ["アイスバーン", "凍結"], "冷え": ["冷える", "低温"],
    "強風": ["強風", "突風", "風雪", "暴風"], "突風": ["突風", "風雪", "強風", "暴風"], "暴風": ["暴風"], "風": ["風"],
    "雨": ["雨"], "なだれ": ["なだれ"], "着雪": ["着雪"], "警戒": ["警戒"], "注意": ["注意"],
}

BANNED = ["国道", "県道", "号線", "高速", "IC", "インター", "通行止めになっ", "通行止め中", "規制中", "規制が出", "規制されて", "閉鎖"]


def label(date):
    d = dt.date.fromisoformat(date)
    return f"{d.month}/{d.day}({WEEK[d.weekday()]})"


def facts(spot, today):
    road = spot.get("road") or {}
    lines = [f"スキー場：{spot['name']}（{spot['region']}、標高 約{spot.get('elev')}m の予報）"]
    if road.get("warnings"):
        lines.append("今出ている気象庁の警報・注意報：" + "、".join(road["warnings"]))
    days = [d for d in road.get("days", []) if d["date"] >= today][:3]
    for d in days:
        lv = "判定できない" if d.get("level") is None else ["ふだんの冬道", "注意", "警戒"][d["level"]]
        pts = "／".join(d.get("points") or []) or "特になし"
        lines.append(f"{label(d['date'])}：{lv}。{pts}")
    return "\n".join(lines), days


def numbers(text):
    return set(re.findall(r"\d+(?:\.\d+)?", text))


def check(text, fact_text):
    """AI の文を機械的に確かめる。だめなら理由を返す"""
    t = text.strip()
    if not t:
        return "空"
    if len(t) > 120:
        return "長すぎる"
    for w in BANNED:
        if w in t:
            return f"使わない言葉「{w}」"
    for name in re.findall(r"[^\s、。：「」（）]{1,6}(?:注意報|警報)", t):
        if not any(name.endswith(w) and w in fact_text for w in re.findall(r"[^\s、。：・]{1,6}(?:注意報|警報)", fact_text)):
            return f"事実にない警報・注意報「{name}」"
    for w in ("今夜", "今朝", "明け方", "追いついていない", "出ています" if "発表中" not in fact_text and "今出ている" not in fact_text else "\0"):
        if w in t and w not in fact_text:
            return f"事実にない言い方「{w}」"
    # 危険・天気の言葉は、事実にその根拠がある時だけ使える（事実が「ふだんの冬道」なのに「大雪で立ち往生」と書く等を捨てる）
    for word, grounds in HAZARDS.items():
        if word in t and not any(g in fact_text for g in grounds):
            return f"事実にない危険・天気「{word}」"
    extra = numbers(t) - numbers(fact_text) - {"1", "2"}
    if extra:
        return f"事実にない数字 {sorted(extra)}"
    if re.search(r"[#*•・\-]\s", t) or "\n" in t:
        return "箇条書き・改行"
    return ""


def chat(fact_text):
    body = json.dumps({"model": OPT.model, "stream": False, "options": {"temperature": 0.2, "num_predict": 160},
                       "messages": [{"role": "system", "content": SYSTEM},
                                    {"role": "user", "content": "事実：\n" + fact_text + "\n\nこの事実だけで、道路の注意を書いてください。"}]}).encode()
    req = urllib.request.Request(OPT.host.rstrip("/") + "/api/chat", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())["message"]["content"].strip()


def main():
    data = json.loads(Path(OPT.data).read_text(encoding="utf-8"))
    today = dt.datetime.now(JST).date().isoformat()
    spots = data.get("spots", [])[: OPT.limit or None]
    texts, rejected, started = {}, {}, time.time()
    for s in spots:
        if not (s.get("road") or {}).get("days"):
            continue
        fact_text, days = facts(s, today)
        try:
            text = chat(fact_text)
        except Exception as e:  # noqa: BLE001
            rejected[s["id"]] = f"AI に聞けず：{str(e)[:120]}"
            continue
        why = check(text, fact_text)
        if why:
            rejected[s["id"]] = f"{why}：{text[:120]}"
            print(f"  × {s['name']}：{why}")
            continue
        texts[s["id"]] = {"text": text.strip(), "dates": [d["date"] for d in days]}
        print(f"  ○ {s['name']}：{text.strip()}")
    out = {"version": 1, "made": dt.datetime.now(JST).isoformat(timespec="minutes"), "based_on": data.get("made"),
           "model": OPT.model, "generator": f"road_ai.py {VERSION}", "seconds": round(time.time() - started),
           "texts": texts, "rejected": rejected}
    Path(OPT.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"できました：{len(texts)}地点（捨てた文 {len(rejected)}）")
    return 0 if texts or not spots else 1


if __name__ == "__main__":
    sys.exit(main())
