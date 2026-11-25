// Metyu fresh data: read the published state without the CDN's stale copy.
//
// raw.githubusercontent.com serves a branch file with "max-age=300" and ignores the query string,
// so the Live Board could show data up to 5 minutes older than the agent's last publish. A commit
// URL (raw.../<sha>/file) is immutable and never stale. So the board asks the GitHub API which
// commit the autopilot-data branch points at (a tiny request: the SHA only, revalidated with its
// ETag by the browser), then reads the files at that commit. Any failure falls back to the branch
// URL, as before. Reads only; nothing is ever sent but the public repository name.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetyuFresh = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BRANCH = 'autopilot-data';
  // GitHub allows 60 unauthenticated API requests an hour per address: one check every 90 s is
  // at most 40 an hour, with room to spare. The agent publishes every 15 minutes.
  const MIN_CHECK_MS = 90000;
  const RATE_LIMIT_PAUSE_MS = 15 * 60000;
  const SHA = /^[0-9a-f]{40}$/;
  const NAME = /^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/;   // plain GitHub names; never "." or ".."

  const isCommitUrl = url => /\/[0-9a-f]{40}\//.test(String(url));

  /**
   * A resolver for one repository. `urls(file)` gives the places to read `file` from, freshest
   * first: the file at the branch's latest known commit, then the branch URL.
   */
  function createResolver({ owner, repo, fetchImpl, now = () => Date.now(), minCheckMs = MIN_CHECK_MS }) {
    if (!NAME.test(owner || '') || !NAME.test(repo || '')) throw new Error('owner and repo must be plain GitHub names');
    const fetcher = fetchImpl || (typeof fetch === 'function' ? fetch.bind(null) : null);
    let sha = null;
    let checkedAt = -Infinity;
    let pausedUntil = 0;
    let pending = null;

    async function check() {
      const at = now();
      if (at < pausedUntil || at - checkedAt < minCheckMs) return sha;
      checkedAt = at;
      try {
        // "no-cache": the browser revalidates its copy with the ETag (a 304 costs no body), and the
        // header stays CORS-safelisted, so there is no preflight request.
        const response = await fetcher(`https://api.github.com/repos/${owner}/${repo}/commits/${BRANCH}`, { headers: { Accept: 'application/vnd.github.sha' }, cache: 'no-cache' });
        if (response.ok) {
          const text = String(await response.text()).trim();
          if (SHA.test(text)) sha = text;
        } else if (response.status === 403 || response.status === 429) {
          const reset = Number(response.headers && response.headers.get && response.headers.get('X-RateLimit-Reset'));
          pausedUntil = Number.isFinite(reset) && reset * 1000 > at ? Math.min(reset * 1000, at + 60 * 60000) : at + RATE_LIMIT_PAUSE_MS;
        }
      } catch (error) { /* offline or blocked: keep the last known commit, the branch URL still works */ }
      return sha;
    }

    /** The branch's latest known commit (one check at a time, at most every minCheckMs). */
    function resolve() {
      if (!pending) pending = check().finally(() => { pending = null; });
      return pending;
    }

    async function urls(file) {
      if (!NAME.test(file || '')) throw new Error('bad file name');
      const base = `https://raw.githubusercontent.com/${owner}/${repo}`;
      const commit = await resolve();
      return commit ? [`${base}/${commit}/${file}`, `${base}/${BRANCH}/${file}`] : [`${base}/${BRANCH}/${file}`];
    }

    return { resolve, urls, get sha() { return sha; }, get pausedUntil() { return pausedUntil; } };
  }

  /** How to fetch a source: a commit URL never changes, so the browser may keep it; others are re-read. */
  const cacheModeFor = url => (isCommitUrl(url) ? 'force-cache' : 'no-store');

  return { createResolver, cacheModeFor, isCommitUrl, BRANCH, MIN_CHECK_MS };
}));
