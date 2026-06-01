const PAGE_SIZE = 60;
const listElement = document.querySelector("#history-list");
const emptyState = document.querySelector("#empty-state");
const loadMoreButton = document.querySelector("#load-more");
const searchInput = document.querySelector("#search-input");
const dateFilter = document.querySelector("#date-filter");
const toggleRecording = document.querySelector("#toggle-recording");
const toggleLabel = document.querySelector("#toggle-label");
const settingsDialog = document.querySelector("#settings-dialog");
const dwellSelect = document.querySelector("#dwell-ms");
const maxItemsSelect = document.querySelector("#max-items");
const toast = document.querySelector("#toast");

let settings;
let offset = 0;
let searchTimer;
let toastTimer;

initialize();

async function initialize() {
  const [settingsResponse, statsResponse] = await Promise.all([
    request({ type: "getSettings" }),
    request({ type: "getStats" })
  ]);
  settings = settingsResponse.settings;
  renderToggle();
  renderStats(statsResponse.stats);
  await resetPosts();
}

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(resetPosts, 180);
});

dateFilter.addEventListener("change", resetPosts);
loadMoreButton.addEventListener("click", loadPosts);

toggleRecording.addEventListener("click", async () => {
  const response = await request({
    type: "setSettings",
    settings: { ...settings, enabled: !settings.enabled }
  });
  settings = response.settings;
  renderToggle();
  showToast(settings.enabled ? "浏览记录已开启" : "浏览记录已暂停");
});

document.querySelector("#open-settings").addEventListener("click", () => {
  dwellSelect.value = String(settings.dwellMs);
  maxItemsSelect.value = String(settings.maxItems);
  settingsDialog.showModal();
});

document.querySelector("#save-settings").addEventListener("click", async () => {
  const response = await request({
    type: "setSettings",
    settings: {
      ...settings,
      dwellMs: Number(dwellSelect.value),
      maxItems: Number(maxItemsSelect.value)
    }
  });
  settings = response.settings;
  settingsDialog.close();
  showToast("设置已保存");
});

document.querySelector("#clear-history").addEventListener("click", async () => {
  if (!confirm("确定清空全部浏览历史吗？这个操作无法撤销。")) return;
  await request({ type: "clearHistory" });
  await refresh();
  showToast("浏览历史已清空");
});

document.querySelector("#export-history").addEventListener("click", async () => {
  const response = await request({ type: "exportData" });
  const blob = new Blob([JSON.stringify(response.payload, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `x-view-history-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("历史记录已导出");
});

document.querySelector("#import-history").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;

  try {
    const payload = JSON.parse(await file.text());
    const response = await request({ type: "importData", payload });
    await refresh();
    showToast(`已导入 ${response.imported} 条记录`);
  } catch {
    showToast("导入失败，请检查文件格式");
  } finally {
    event.target.value = "";
  }
});

async function refresh() {
  const statsResponse = await request({ type: "getStats" });
  renderStats(statsResponse.stats);
  await resetPosts();
}

async function resetPosts() {
  offset = 0;
  listElement.replaceChildren();
  await loadPosts();
}

async function loadPosts() {
  const query = searchInput.value.trim();
  const response = await request({
    type: "getPosts",
    query,
    offset,
    limit: PAGE_SIZE,
    since: getSinceTimestamp()
  });

  offset += response.posts.length;
  renderPosts(response.posts);
  loadMoreButton.hidden = !response.hasMore;
  emptyState.hidden = listElement.childElementCount > 0;
  document.querySelector("#results-title").textContent = query ? "搜索结果" : "最近浏览";
}

function renderPosts(posts) {
  for (const post of posts) {
    const card = document.createElement("article");
    card.className = "history-card";

    const content = document.createElement("div");
    const head = document.createElement("div");
    head.className = "post-head";
    head.append(
      textElement("span", "author-name", post.authorName || post.authorHandle || "未知作者"),
      textElement("span", "author-handle", post.authorHandle),
      textElement("span", "post-time", `浏览于 ${formatDate(post.lastViewedAt)}`)
    );

    const body = textElement("p", "post-text", post.text || "这条帖子没有文本内容");
    const meta = document.createElement("div");
    meta.className = "post-meta";
    meta.append(
      textElement("span", "", post.postedAt ? `发布于 ${formatDate(post.postedAt)}` : ""),
      textElement("span", "", post.mediaType ? `· ${mediaLabel(post.mediaType)}` : ""),
      textElement("span", "", post.viewCount > 1 ? `· 看过 ${post.viewCount} 次` : "")
    );
    content.append(head, body, meta);

    const link = textElement("a", "open-post", "在 X 中打开");
    link.href = post.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    card.append(content, link);
    listElement.append(card);
  }
}

function renderStats(stats) {
  document.querySelector("#stat-total").textContent = stats.total;
  document.querySelector("#stat-today").textContent = stats.today;
  document.querySelector("#stat-authors").textContent = stats.authors;
}

function renderToggle() {
  toggleRecording.setAttribute("aria-pressed", String(settings.enabled));
  toggleLabel.textContent = settings.enabled ? "正在记录" : "记录已暂停";
}

function getSinceTimestamp() {
  const days = Number(dateFilter.value);
  if (!days) return 0;

  const since = new Date();
  if (days === 1) {
    since.setHours(0, 0, 0, 0);
  } else {
    since.setDate(since.getDate() - days);
  }
  return since.getTime();
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function mediaLabel(type) {
  return type === "video" ? "视频" : "图片";
}

function textElement(tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function showToast(text) {
  window.clearTimeout(toastTimer);
  toast.textContent = text;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

function request(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "扩展暂时无法响应"));
        return;
      }
      resolve(response);
    });
  });
}
