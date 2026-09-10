/**
 * Site-rules engine: per-host selector overrides for the handful of sites the
 * generic walker gets wrong.
 *
 * Deliberately small: 3 selector families (exclude/include/ignore-opt-out),
 * hostname-only matching (no URL path patterns), no merge deltas, no
 * `minCharacters`/`minWords`, no CSS injection — there is no options UI or
 * user-rule surface here, so a "merge many matching rules" mechanism would
 * have nothing to merge. Selectors are hardcoded, unit-tested constants (not
 * user input): a bad selector is a bug to catch in tests, not a runtime
 * fallback.
 *
 * Based on: docs/packages/web-translate/README.md §7.1a
 */

export type ResolvedSiteRules = {
  /** Comma-joined selector list; an element matching it (and its subtree) is never walked or translated. */
  excludeSelector: string | null
  /** Comma-joined selector list; when set, only elements inside (`.closest()`) one of them can become a translation unit. */
  includeSelector: string | null
  /**
   * Comma-joined selector list; an element inside (`.closest()`) a match
   * bypasses the page's machine-translation opt-out markers (`.notranslate`,
   * `translate="no"`, `contenteditable`). For sites that blanket-mark their
   * READ-ONLY content with these to fend off DOM-rewriting translators
   * (Google Translate breaks their renderer) — our appended-wrapper rendering
   * never rewrites page text nodes, so the marker's reason doesn't apply.
   * Never bypasses structural skips (non-content tags, aria-hidden, own output).
   */
  ignoreOptOutSelector: string | null
}

type BuiltInRule = {
  id: string
  /** `"*"` always matches; a leading `*.` matches the bare suffix too (`*.wikipedia.org` matches `wikipedia.org`). */
  hosts: string[]
  excludeSelectors?: string[]
  includeSelectors?: string[]
  ignoreOptOutSelectors?: string[]
}

const GLOBAL_RULE: BuiltInRule = {
  id: "global-preserve",
  hosts: ["*"],
  excludeSelectors: ["#movie_player", "#lingo-tr-subtitles-host", "nav", '[role="navigation"]', "button", '[role="button"]'],
}

const GITHUB_RULE: BuiltInRule = {
  id: "github",
  hosts: ["github.com"],
  excludeSelectors: [
    "header",
    ".blob-code",
    "a[data-hovercard-type]",
    '[data-testid^="breadcrumbs"]',
    "table.diff-table",
    '[data-test-selector="commit-tease-commit-message"]',
    ".timeline-comment-header",
  ],
  includeSelectors: [".markdown-body", "article", "h1", "h2", "h3", '[itemprop="description"]', ".markdown-title"],
}

const TWITTER_RULE: BuiltInRule = {
  id: "twitter",
  hosts: ["twitter.com", "x.com"],
  includeSelectors: [
    '[data-testid="tweetText"]',
    '[data-testid="UserDescription"]',
    '[data-testid="twitterArticleReadView"]',
    '[data-testid="HoverCard"] div[dir="auto"]',
  ],
}

const WIKIPEDIA_RULE: BuiltInRule = {
  id: "wikipedia",
  hosts: ["*.wikipedia.org"],
  excludeSelectors: [".mw-editsection", ".mw-cite-backlink", "#p-lang-btn", ".vector-header", "#right-navigation", "#p-associated-pages"],
}

/**
 * Notion marks its whole body with `notranslate`/`contenteditable` to stop
 * DOM-rewriting translators from corrupting its editor (Chrome's built-in
 * translate fails there for the same reason). Public share
 * pages (`*.notion.site`) are read-only, so the marker's reason doesn't apply
 * to our appended-wrapper rendering. The `notion.so` editing app is
 * deliberately NOT listed — V1 skips live editable regions by design.
 */
const NOTION_RULE: BuiltInRule = {
  id: "notion",
  hosts: ["*.notion.site"],
  ignoreOptOutSelectors: ["[data-block-id]", "[data-content-editable-leaf]"],
}

const BUILT_IN_RULES: BuiltInRule[] = [GLOBAL_RULE, GITHUB_RULE, TWITTER_RULE, WIKIPEDIA_RULE, NOTION_RULE]

function hostMatches(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1) // ".example.com"
    return hostname === pattern.slice(2) || hostname.endsWith(suffix)
  }
  return hostname === pattern
}

function joinSelectors(selectors: string[]): string | null {
  return selectors.length > 0 ? selectors.join(", ") : null
}

/** Resolved once per content-script instance from `location.hostname` — none of the built-in rules are path-scoped, so there is no need to re-resolve per walk or per SPA route change. */
export function resolveSiteRules(hostname: string): ResolvedSiteRules {
  const matched = BUILT_IN_RULES.filter((rule) => rule.hosts.some((pattern) => hostMatches(hostname, pattern)))
  return {
    excludeSelector: joinSelectors(matched.flatMap((rule) => rule.excludeSelectors ?? [])),
    includeSelector: joinSelectors(matched.flatMap((rule) => rule.includeSelectors ?? [])),
    ignoreOptOutSelector: joinSelectors(matched.flatMap((rule) => rule.ignoreOptOutSelectors ?? [])),
  }
}
