const DB_NAME = "x-view-history";
const DB_VERSION = 1;
const POSTS_STORE = "posts";
const SETTINGS_KEY = "settings";

const DEFAULT_SETTINGS = {
  enabled: true,
  dwellMs: 1200,
  maxItems: 30000
};

let databasePromise;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await openDatabase();
  await updateBadgeCount();
});

chrome.runtime.onStartup.addListener(updateBadgeCount);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error("[X 浏览历史]", error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

async function handleMessage(message = {}) {
  switch (message.type) {
    case "recordPost":
      return { post: await recordPost(message.post) };
    case "getSettings":
      return { settings: await ensureSettings() };
    case "setSettings":
      return { settings: await saveSettings(message.settings) };
    case "getPosts":
      return getPosts(message);
    case "getStats":
      return { stats: await getStats() };
    case "clearHistory":
      await clearHistory();
      return {};
    case "exportData":
      return exportData();
    case "importData":
      return importData(message.payload);
    default:
      throw new Error("未知请求");
  }
}

async function recordPost(rawPost) {
  const settings = await ensureSettings();
  if (!settings.enabled) return null;

  const post = normalizePost(rawPost);
  const db = await openDatabase();
  const existing = await requestToPromise(
    db.transaction(POSTS_STORE).objectStore(POSTS_STORE).get(post.id)
  );

  const nextPost = {
    ...existing,
    ...post,
    firstViewedAt: existing?.firstViewedAt || post.lastViewedAt,
    lastViewedAt: post.lastViewedAt,
    viewCount: (existing?.viewCount || 0) + 1
  };

  await requestToPromise(
    db
      .transaction(POSTS_STORE, "readwrite")
      .objectStore(POSTS_STORE)
      .put(nextPost)
  );

  await pruneHistory(settings.maxItems);
  await updateBadgeCount();
  return nextPost;
}

function normalizePost(rawPost = {}) {
  const id = String(rawPost.id || "").trim();
  const url = String(rawPost.url || "").trim();
  if (!id || !url) throw new Error("帖子缺少可记录的地址");

  return {
    id,
    url,
    authorName: cleanText(rawPost.authorName, 120),
    authorHandle: cleanText(rawPost.authorHandle, 80),
    text: cleanText(rawPost.text, 12000),
    postedAt: normalizeDate(rawPost.postedAt),
    lastViewedAt: Date.now(),
    mediaType: cleanText(rawPost.mediaType, 32)
  };
}

async function getPosts({ query = "", limit = 100, offset = 0, since = 0 } = {}) {
  const normalizedQuery = String(query).trim().toLowerCase();
  const safeLimit = clampNumber(limit, 1, 500, 100);
  const safeOffset = clampNumber(offset, 0, 100000, 0);
  const safeSince = Number(since) || 0;
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const posts = [];
    let matched = 0;
    let hasMore = false;
    const transaction = db.transaction(POSTS_STORE);
    const index = transaction.objectStore(POSTS_STORE).index("lastViewedAt");
    const cursorRequest = index.openCursor(null, "prev");

    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve({ posts, hasMore });
        return;
      }

      const post = cursor.value;
      const isRecentEnough = post.lastViewedAt >= safeSince;
      const isMatch = !normalizedQuery || searchableText(post).includes(normalizedQuery);

      if (isRecentEnough && isMatch) {
        if (matched >= safeOffset && posts.length < safeLimit) {
          posts.push(post);
        } else if (matched >= safeOffset + safeLimit) {
          hasMore = true;
          resolve({ posts, hasMore });
          return;
        }
        matched += 1;
      }

      cursor.continue();
    };
  });
}

async function getStats() {
  const posts = await getAllPosts();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  return {
    total: posts.length,
    today: posts.filter((post) => post.lastViewedAt >= todayStart.getTime()).length,
    authors: new Set(posts.map((post) => post.authorHandle).filter(Boolean)).size
  };
}

async function exportData() {
  return {
    payload: {
      exportedAt: new Date().toISOString(),
      version: 1,
      settings: await ensureSettings(),
      posts: await getAllPosts()
    }
  };
}

async function importData(payload = {}) {
  const posts = Array.isArray(payload.posts) ? payload.posts : [];
  const db = await openDatabase();
  const transaction = db.transaction(POSTS_STORE, "readwrite");
  const store = transaction.objectStore(POSTS_STORE);
  let imported = 0;

  for (const rawPost of posts) {
    try {
      const normalized = normalizeImportedPost(rawPost);
      store.put(normalized);
      imported += 1;
    } catch {
      // Ignore malformed records from external files.
    }
  }

  await transactionToPromise(transaction);
  const settings = await ensureSettings();
  await pruneHistory(settings.maxItems);
  await updateBadgeCount();
  return { imported };
}

function normalizeImportedPost(rawPost = {}) {
  const post = normalizePost(rawPost);
  return {
    ...post,
    firstViewedAt: normalizeTimestamp(rawPost.firstViewedAt, post.lastViewedAt),
    lastViewedAt: normalizeTimestamp(rawPost.lastViewedAt, post.lastViewedAt),
    viewCount: clampNumber(rawPost.viewCount, 1, 1000000, 1)
  };
}

async function clearHistory() {
  const db = await openDatabase();
  await requestToPromise(
    db.transaction(POSTS_STORE, "readwrite").objectStore(POSTS_STORE).clear()
  );
  await updateBadgeCount();
}

async function pruneHistory(maxItems) {
  const db = await openDatabase();
  const transaction = db.transaction(POSTS_STORE, "readwrite");
  const store = transaction.objectStore(POSTS_STORE);
  const count = await requestToPromise(store.count());
  let remaining = Math.max(0, count - maxItems);
  if (!remaining) return;

  await new Promise((resolve, reject) => {
    const cursorRequest = store.index("lastViewedAt").openCursor();
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || remaining <= 0) {
        resolve();
        return;
      }
      cursor.delete();
      remaining -= 1;
      cursor.continue();
    };
  });
  await transactionToPromise(transaction);
}

async function getAllPosts() {
  const db = await openDatabase();
  return requestToPromise(
    db.transaction(POSTS_STORE).objectStore(POSTS_STORE).getAll()
  );
}

async function updateBadgeCount() {
  const db = await openDatabase();
  const count = await requestToPromise(
    db.transaction(POSTS_STORE).objectStore(POSTS_STORE).count()
  );

  await chrome.action.setBadgeBackgroundColor({ color: "#1D9BF0" });
  await chrome.action.setBadgeText({
    text: count > 999 ? "999+" : count ? String(count) : ""
  });
}

async function ensureSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return saveSettings(stored[SETTINGS_KEY] || {});
}

async function saveSettings(partialSettings = {}) {
  const settings = {
    enabled:
      typeof partialSettings.enabled === "boolean"
        ? partialSettings.enabled
        : DEFAULT_SETTINGS.enabled,
    dwellMs: clampNumber(
      partialSettings.dwellMs,
      500,
      10000,
      DEFAULT_SETTINGS.dwellMs
    ),
    maxItems: clampNumber(
      partialSettings.maxItems,
      1000,
      100000,
      DEFAULT_SETTINGS.maxItems
    )
  };

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradened = () => {
      const db = request.result;
      const store = db.createObjectStore(POSTS_STORE, { keyPath: "id" });
      store.createIndex("lastViewedAt", "lastViewedAt");
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error);
    };
  });

  return databasePromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeDate(value) {
  if (!value) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function normalizeTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function searchableText(post) {
  return [
    post.authorName,
    post.authorHandle,
    post.text,
    post.url
  ]
    .join(" ")
    .toLowerCase();
}
