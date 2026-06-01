const ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
const MIN_VISIBLE_RATIO = 0.35;
const MIN_VISIBLE_PIXELS = 180;
const RECORD_COOLDOWN_MS = 60 * 1000;
const RETRY_DELAY_MS = 2000;
const SWEEP_INTERVAL_MS = 4000;

let settings = {
  enabled: true,
  dwellMs: 1200
};

const observedArticles = new WeakSet();
const dwellTimers = new Map();
const recentPostIds = new Map();

const visibilityObserver = new IntersectionObserver(handleVisibility, {
  threshold: [0, 0.1, 0.25, MIN_VISIBLE_RATIO, 0.8]
});

loadSettings();
observeTweets(document);
scheduleVisibleTweets();
window.setInterval(scheduleVisibleTweets, SWEEP_INTERVAL_MS);

const pageObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof Element) observeTweets(node);
    }
  }
});
pageObserver.observe(document.body, {
  childList: true,
  subtree: true
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings) return;
  settings = { ...settings, ...changes.settings.newValue };
  if (!settings.enabled) {
    clearAllTimers();
    return;
  }
  scheduleVisibleTweets();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearAllTimers();
    return;
  }
  scheduleVisibleTweets();
});

window.addEventListener("focus", scheduleVisibleTweets);
window.addEventListener("pageshow", scheduleVisibleTweets);

function loadSettings() {
  chrome.runtime.sendMessage({ type: "getSettings" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) return;
    settings = { ...settings, ...response.settings };
    scheduleVisibleTweets();
  });
}

function observeTweets(root) {
  if (root.matches?.(ARTICLE_SELECTOR)) observeTweet(root);
  root.querySelectorAll?.(ARTICLE_SELECTOR).forEach(observeTweet);
}

function observeTweet(article) {
  if (observedArticles.has(article)) return;
  observedArticles.add(article);
  visibilityObserver.observe(article);
}

function handleVisibility(entries) {
  for (const entry of entries) {
    const article = entry.target;
    if (!settings.enabled || !isMeaningfullyVisible(entry)) {
      resetArticleVisibility(article);
      continue;
    }

    scheduleRecord(article);
  }
}

function recordVisibleTweet(article) {
  clearTimer(article);
  if (!settings.enabled || document.hidden || !isArticleVisible(article)) return;

  const post = extractPost(article);
  if (!post) {
    scheduleRecord(article, RETRY_DELAY_MS);
    return;
  }

  if (article.dataset.xHistoryRecorded === post.id || wasPostRecordedRecently(post.id)) {
    return;
  }
  if (article.dataset.xHistoryRecording === post.id) return;

  article.dataset.xHistoryRecording = post.id;
  chrome.runtime.sendMessage({ type: "recordPost", post }, (response) => {
    const failed = chrome.runtime.lastError || !response?.ok;
    delete article.dataset.xHistoryRecording;

    if (failed) {
      if (isArticleVisible(article)) scheduleRecord(article, RETRY_DELAY_MS);
      return;
    }

    article.dataset.xHistoryRecorded = post.id;
    article.dataset.xHistoryRecordedAt = String(Date.now());
    recentPostIds.set(post.id, Date.now());
  });
}

function scheduleRecord(article, delay = settings.dwellMs) {
  if (dwellTimers.has(article)) return;
  const timer = window.setTimeout(() => recordVisibleTweet(article), delay);
  dwellTimers.set(article, timer);
}

function scheduleVisibleTweets() {
  if (!settings.enabled || document.hidden) return;
  pruneRecentPostIds();
  observeTweets(document);
  document.querySelectorAll(ARTICLE_SELECTOR).forEach((article) => {
    if (isArticleVisible(article)) {
      scheduleRecord(article);
    } else {
      resetArticleVisibility(article);
    }
  });
}

function wasPostRecordedRecently(postId) {
  const recordedAt = recentPostIds.get(postId);
  return recordedAt && Date.now() - recoredAt < RECORD_COOLDOWN_MS;
}

function pruneRecentPostIds() {
  const oldestAllowed = Date.now() - RECORD_COOLDOWN_MS;
  for (const [postId, recordedAt] of recentPostIds) {
    if (recordedAt < oldestAllowed) recentPostIds.delete(postId);
  }
}

function isMeaningfullyVisible(entry) {
  const requiredVisiblePixels = Math.min(
    MIN_VISIBLE_PIXELS,
    entry.boundingClientRect.height * MIN_VISIBLE_RATIO
  );
  return entry.isIntersecting && entry.intersectionRect.height >= requiredVisiblePixels;
}

function isArticleVisible(article) {
  const rect = article.getBoundingClientRect();
  const visibleHeight =
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
  const requiredVisiblePixels = Math.min(
    MIN_VISIBLE_PIXELS,
    rect.height * MIN_VISIBLE_RATIO
  );
  return visibleHeight >= requiredVisiblePixels;
}

function extractPost(article) {
  const statusAnchor = findStatusAnchor(article);
  if (!statusAnchor) return null;

  const match = new URL(statusAnchor.href, location.origin).pathname.match(
    /^\/([^/]+)\/status\/(\d+)/
  );
  if (!match) return null;

  const [, urlHandle, id] = match;
  const time = article.querySelector("time");
  const tweetText = article.querySelector('[data-testid="tweetText"]');
  const userName = article.querySelector('[data-testid="User-Name"]');
  const userText = userName?.innerText || "";
  const handleMatch = userText.match(/@[[A-Za-z0-9_]+/);

  return {
    id,
    url: `https://x.com/${urlHandle}/status/${id}`,
    authorName: getAuthorName(userText),
    authorHandle: handleMatch?.[0] || `@${urlHandle}`,
    text: tweetText?.innerText || "",
    postedAt: time?.dateTime || "",
    mediaType: getMediaType(article)
  };
}

function findStatusAnchor(article) {
  const timestampAnchor = article.querySelector("time")?.closest('a[href*="/status/"]');
  if (timestampAnchor) return timestampAnchor;

  return [...article.querySelectorAll('a[href*="/status/"]')].find((anchor) =>
    /^\/[^/]+\/status\/\d+/.test(new URL(anchor.href, location.origin).pathname)
  );
}

function getAuthorName(userText) {
  return userText
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("@") && !part.includes("·")) || "";
}

function getMediaType(article) {
  if (article.querySelector('[data-testid="videoPlayer"]')) return "video";
  if (article.querySelector('[data-testid="tweetPhoto"]')) return "image";
  return "";
}

function clearTimer(article) {
  const timer = dwellTimers.get(article);
  if (!timer) return;
  window.clearTimeout(timer);
  dwellTimers.delete(article);
}

function resetArticleVisibility(article) {
  clearTimer(article);
  delete article.dataset.xHistoryRecorded;
  delete article.dataset.xHistoryRecordedAt;
}

function clearAllTimers() {
  for (const timer of dwellTimers.values()) {
    window.clearTimeout(timer);
  }
  dwellTimers.clear();
}
