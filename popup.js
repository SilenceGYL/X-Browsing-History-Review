const resultsElement = document.querySelector("#results");
const emptyState = document.querySelector("#empty-state");
const searchInput = document.querySelector("#search-input");
const resultsTitle = document.querySelector("#results-title");
const toggleRecording = document.querySelector("#toggle-recording");
const toggleLabel = document.querySelector("#toggle-label");
let settings;
let searchTimer;

initialize();

async function initialize() {
  const [settingsResponse, statsResponse] = await Promise.all([
    request({ type: "getSettings" }),
    request({ type: "getStats" })
  ]);
  settings = settingsResponse.settings;
  renderToggle();
  renderStats(statsResponse.stats);
  await loadPosts();
}

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(loadPosts, 160);
});

toggleRecording.addEventListener("click", async () => {
  const response = await request({
    type: "setSettings",
    settings: { ...settings, enabled: !settings.enabled }
  });
  settings = response.settings;
  renderToggle();
});

document.querySelector("#open-history").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
});

async function loadPosts() {
  const query = searchInput.value.trim();
  const response = await request({ type: "getPosts", query, limit: 7 });
  resultsTitle.textContent = query ? "搜索结果" : "最近浏览";
  renderPosts(response.posts);
}

function renderStats(stats) {
  document.querySelector("#stat-today").textContent = stats.today;
  document.querySelector("#stat-total").textContent = stats.total;
}

function renderToggle() {
  toggleRecording.setAttribute("aria-pressed", String(settings.enabled));
  toggleLabel.textContent = settings.enabled ? "记录中" : "已暂停";
}

function renderPosts(posts) {
  resultsElement.replaceChildren();
  emptyState.hidden = posts.length > 0;

  for (const post of posts) {
    const link = document.createElement("a");
    link.className = "result";
    link.href = post.url;
    link.target = "_blank";

    const head = document.createElement("div");
    head.className = "result-head";
    head.append(
      textElement("span", "result-author", post.authorName || post.authorHandle || "未知作者"),
      textElement("span", "result-time", relativeTime(post.lastViewedAt))
    );

    const body = textElement("p", "result-text", post.text || "这条帖子没有文本内容");
    const meta = document.createElement("div");
    meta.className = "result-meta";
    meta.append(
      textElement("span", "", post.authorHandle || "X 帖子"),
      textElement("span", "", post.viewCount > 1 ? `看过 ${post.viewCount} 次` : "")
    );
    link.append(head, body, meta);
    resultsElement.append(link);
  }
}

function textElement(tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function relativeTime(timestamp) {
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
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
