# スタンスメモ（Claude 試作）

正式版 https://kanon6343.github.io/snowboard-stance-memo/ （はるくんと開発）とは別の、Claude 用の試作リポジトリです。
正式版の main 0332dcd（v2.4.2 / release 1090）から作りました。正式版のリポジトリには何も送っていません。

## 正式版との違い
- 保存キーを `main:` → `claude:` に変更（同じ github.io の中で、正式版の履歴を読み書きしないため）。Service Worker のキャッシュ名も `snowboard-stance-claude:` に変更。
- アプリ名を「スタンスメモ（Claude試作）」「スタンスメモC」に変更（ホーム画面で見分けるため）。
- メニュー → 表示 の一番上に「❄ 雪山情報」を追加（`index.html` の `#snowReportCard`）。
- `snow/` … 雪山レポート（毎朝作り直す静的ページ）。`snow/resorts.json` が対象のスキー場、`snow/data/` が毎日の予報と実測の記録。
- `tools/yukiyama.py` … 雪山レポートを作るプログラム（Python 標準ライブラリだけ、AI は使わない）。
  - 実測: 気象庁アメダスの積雪 ／ 予報: Open-Meteo のアンサンブル予報（ECMWF・GFS、約80通り）
- `.github/workflows/snow-report.yml` … 1日4回（5:00・11:00・17:00・23:00 JST、数分〜数十分遅れることあり）に `snow/` を作り直してコミット（手動実行も可）。予報の記録は `snow/data/日付_時.json` に毎回残す。

## 正式版へ取り込む時の注意（はるくん向け）
- 取り込むのは `snow/`・`tools/`・`.github/workflows/`・`index.html` の `#snowReportCard` だけ。保存キー・キャッシュ名・アプリ名の変更は試作専用なので戻すこと。
- `index.html` を変えるので、正式版の決まりどおり RELEASE と版つきアセットを上げる。`snow/` は SHELL に入れない（入れると古い予報がキャッシュされる）。
- 毎朝のコミットが main に入るので、作業ブランチの rebase が必要になることがある。

バージョン: 雪山レポート v00.03.00
