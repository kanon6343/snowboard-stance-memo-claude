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

VERSION = "v00.01.00"
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
        lv = ["ふだんの冬道", "注意", "警戒"][d.get("level", 0)]
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
