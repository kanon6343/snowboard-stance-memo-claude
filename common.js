/* 共通：保存キー・HTMLの逃がし・履歴の読み書き。ほかの全部の JS より先に読む */
const KEY_PREFIX = "claude:";
const KEY = `${KEY_PREFIX}snowboard-history-v1`;
const UI_KEY = `${KEY_PREFIX}snowboard-ui-v1`;
const VIEW_KEY = `${KEY_PREFIX}last-view-v1`;

const HTML_ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"};
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

// 保存履歴を読む。壊れていたら例外（空の履歴として上書きしないため）
function readHistorySnapshot() {
  const raw = localStorage.getItem(KEY), items = JSON.parse(raw === null ? "[]" : raw);
  if (!Array.isArray(items) || items.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Invalid history");
  return { raw, items };
}
// 読んだ時から別の画面で変わっていなければ書く。変わっていたら false（書かない）
function writeHistoryIfUnchanged(expectedRaw, items) {
  if (localStorage.getItem(KEY) !== expectedRaw) return false;
  localStorage.setItem(KEY, JSON.stringify(items));
  return true;
}
