// Shared HTML-scraping helpers for the research-mode tool routes. Ported
// from the local `kompass ui`'s src/ui/tools.ts webSearchTool/webFetchTool —
// same DuckDuckGo HTML-endpoint scrape (no API key), same regex parse. Runs
// server-side here (a Vercel serverless function) rather than a local Node
// process, since a browser fetch to duckduckgo.com would hit CORS.
const MAX_OUTPUT = 20_000;

export function clip(s: string, max = MAX_OUTPUT): string {
  return s.length > max
    ? s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`
    : s;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  deg: "°",
  eacute: "é",
  egrave: "è",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  times: "×",
  frac12: "½",
};

/**
 * Decode HTML entities to the characters they stand for.
 *
 * The previous version mapped every numeric entity to a SPACE, so `&#39;` —
 * by far the most common one on the web — turned "don't" into "don t" and
 * "Gandhi&#39;s" into "Gandhi s" in every snippet and every fetched page the
 * models read. Quoting a mangled source accurately is impossible, so this is an
 * accuracy fix rather than a cosmetic one.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Lone surrogates and out-of-range values would throw; leave them as-is.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      if (code >= 0xd800 && code <= 0xdfff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search runs a FALLBACK CHAIN, the same idea as the gateway's model chains and
 * for the same reason: any single free backend will refuse us sooner or later.
 *
 * DuckDuckGo's HTML endpoint returns 403 to Vercel's datacenter IPs — verified
 * live against the deployed function while every agent in the AI Council was
 * answering "I'm currently unable to access search results" from memory. A
 * browser User-Agent matters too: the previous one announced itself as
 * "KompassAI/1.0", which is trivially blockable.
 *
 * Each backend is tried in turn; an empty result set counts as a failure and
 * falls through, because a 200 carrying a challenge page is the common shape of
 * being blocked. The winning backend's name is returned so callers (and the
 * /api/tools/web_search route) can report what actually served the query.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SEARCH_HEADERS = {
  "user-agent": BROWSER_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).trim();
}

/** DuckDuckGo HTML — best quality when it lets us through. */
async function ddgHtml(query: string): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      ...SEARCH_HEADERS,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const linkRe =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(snippetRe)].map((m) =>
    stripTags(m[1] ?? ""),
  );
  const out: SearchResult[] = [];
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    if (out.length >= 8) break;
    let url = m[1] ?? "";
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) continue;
    out.push({ title: stripTags(m[2] ?? ""), url, snippet: snippets[i] ?? "" });
    i++;
  }
  return out;
}

/** DuckDuckGo Lite — a different frontend, sometimes allowed when the above is not. */
async function ddgLite(query: string): Promise<SearchResult[]> {
  const res = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      ...SEARCH_HEADERS,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const out: SearchResult[] = [];
  const linkRe =
    /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(linkRe)) {
    if (out.length >= 8) break;
    let url = m[1] ?? "";
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) continue;
    out.push({ title: stripTags(m[2] ?? ""), url, snippet: "" });
  }
  return out;
}

/** Mojeek — an independent index that tolerates plain HTTP clients. */
async function mojeek(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`,
    {
      headers: SEARCH_HEADERS,
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const out: SearchResult[] = [];
  // Mojeek results are <a class="ob"> (title link) inside <li>, with the
  // description in <p class="s">.
  const blockRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  for (const b of html.matchAll(blockRe)) {
    if (out.length >= 8) break;
    const block = b[1] ?? "";
    const link =
      /<a[^>]*class="[^"]*ob[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(
        block,
      );
    if (!link) continue;
    const url = link[1] ?? "";
    if (!/^https?:\/\//.test(url)) continue;
    const desc = /<p[^>]*class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({
      title: stripTags(link[2] ?? ""),
      url,
      snippet: stripTags(desc?.[1] ?? ""),
    });
  }
  return out;
}

/**
 * Wikipedia — the guaranteed floor. Narrow, but it is a real API with no key,
 * no blocking and no scraping, so the council is never left with nothing at all.
 */
async function wikipedia(query: string): Promise<SearchResult[]> {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=" +
    encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      "user-agent": "KompassAI/1.0 (https://github.com/vinoth4v/kompass)",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    query?: { search?: { title: string; snippet: string }[] };
  };
  return (json.query?.search ?? []).map((r) => ({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    snippet: stripTags(r.snippet),
  }));
}

type Backend = { name: string; run: (q: string) => Promise<SearchResult[]> };

// ── Keyed general-web providers ──────────────────────────────────────────────
// Free tiers, but they need a signup. Keys live in Vercel environment variables
// (server-side only — they never reach the browser, same trust split as the
// gateway bearer). A provider with no key configured is skipped silently.

async function brave(query: string): Promise<SearchResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("no key");
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(query)}`,
    {
      headers: { accept: "application/json", "x-subscription-token": key },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    web?: {
      results?: { title?: string; url?: string; description?: string }[];
    };
  };
  return (json.web?.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: stripTags(r.title ?? r.url ?? ""),
      url: r.url!,
      snippet: stripTags(r.description ?? ""),
    }));
}

async function tavily(query: string): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("no key");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: 8,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      snippet: (r.content ?? "").slice(0, 300),
    }));
}

async function serper(query: string): Promise<SearchResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("no key");
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ q: query, num: 8 }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    organic?: { title?: string; link?: string; snippet?: string }[];
  };
  return (json.organic ?? [])
    .filter((r) => r.link)
    .map((r) => ({
      title: r.title ?? r.link!,
      url: r.link!,
      snippet: r.snippet ?? "",
    }));
}

async function exa(query: string): Promise<SearchResult[]> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("no key");
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: 8, type: "auto" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { title?: string; url?: string; text?: string }[];
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      snippet: (r.text ?? "").slice(0, 300),
    }));
}

// ── Keyless specialist sources ───────────────────────────────────────────────
// Real APIs rather than scrapes, so a datacenter IP cannot be blocked the way
// DuckDuckGo and Mojeek block us. Individually narrow; aggregated they cover a
// lot of what a developer actually asks about, and crucially they are CURRENT —
// which Wikipedia alone is not.

/** Hacker News via Algolia. Excellent for tooling, launches and current opinion. */
async function hackernews(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=6&query=${encodeURIComponent(query)}`,
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    hits?: {
      title?: string;
      url?: string;
      objectID?: string;
      points?: number;
    }[];
  };
  return (json.hits ?? [])
    .filter((h) => h.title)
    .map((h) => ({
      title: h.title!,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: `Hacker News${h.points ? ` · ${h.points} points` : ""}`,
    }));
}

/** GitHub repositories — what tooling actually exists and is maintained. */
async function github(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.github.com/search/repositories?per_page=5&sort=stars&q=${encodeURIComponent(query)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "KompassAI/1.0 (https://github.com/vinoth4v/kompass)",
      },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    items?: {
      full_name?: string;
      html_url?: string;
      description?: string;
      stargazers_count?: number;
    }[];
  };
  return (json.items ?? [])
    .filter((r) => r.html_url)
    .map((r) => ({
      title: `${r.full_name} (${r.stargazers_count ?? 0}★)`,
      url: r.html_url!,
      snippet: r.description ?? "",
    }));
}

/** Stack Overflow — concrete problems and their accepted answers. */
async function stackexchange(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=5&site=stackoverflow&q=" +
      encodeURIComponent(query),
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    items?: {
      title?: string;
      link?: string;
      score?: number;
      is_answered?: boolean;
    }[];
  };
  return (json.items ?? [])
    .filter((r) => r.link)
    .map((r) => ({
      title: decodeEntities(r.title ?? r.link!),
      url: r.link!,
      snippet: `Stack Overflow · score ${r.score ?? 0}${r.is_answered ? " · answered" : ""}`,
    }));
}

/** arXiv — primary research, for questions where papers are the real source. */
async function arxiv(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://export.arxiv.org/api/query?max_results=5&search_query=all:${encodeURIComponent(query)}`,
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const out: SearchResult[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1] ?? "";
    const id = /<id>([^<]+)<\/id>/.exec(e)?.[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(e)?.[1];
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(e)?.[1];
    if (!id || !title) continue;
    out.push({
      title: stripTags(title).replace(/\s+/g, " "),
      url: id.trim(),
      snippet: stripTags(summary ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 300),
    });
  }
  return out;
}

/**
 * Marginalia — an independent, non-commercial index with a genuinely keyless
 * public API. Not a scrape, so datacenter IPs are not refused. Its index favours
 * small independent sites over SEO-optimised commercial pages, which is a real
 * strength for research and a real weakness for mainstream/news queries.
 */
async function marginalia(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { url?: string; title?: string; description?: string }[];
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .slice(0, 8)
    .map((r) => ({
      title: stripTags(r.title ?? r.url!),
      url: r.url!,
      snippet: stripTags(r.description ?? ""),
    }));
}

/** mwmbl — an open-source, community-crawled index. Keyless API, modest
 *  coverage. Titles arrive as bolded segments, which are joined back together. */
async function mwmbl(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.mwmbl.org/api/v1/search/?s=${encodeURIComponent(query)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    url?: string;
    title?: { value?: string }[];
    extract?: { value?: string }[];
  }[];
  const join = (parts?: { value?: string }[]) =>
    (parts ?? []).map((p) => p.value ?? "").join("");
  return (Array.isArray(json) ? json : [])
    .filter((r) => r.url)
    .slice(0, 8)
    .map((r) => ({
      title: stripTags(join(r.title)) || r.url!,
      url: r.url!,
      snippet: stripTags(join(r.extract)).slice(0, 300),
    }));
}

const KEYED: Backend[] = [
  { name: "brave", run: brave },
  { name: "tavily", run: tavily },
  { name: "serper", run: serper },
  { name: "exa", run: exa },
];

// Keyless general web. The scraped engines are listed first for quality but all
// of them refuse datacenter IPs; marginalia and mwmbl are real APIs and do not.
const KEYLESS_WEB: Backend[] = [
  { name: "duckduckgo", run: ddgHtml },
  { name: "duckduckgo-lite", run: ddgLite },
  { name: "mojeek", run: mojeek },
  { name: "marginalia", run: marginalia },
  { name: "mwmbl", run: mwmbl },
];

const SPECIALIST: Backend[] = [
  { name: "hackernews", run: hackernews },
  { name: "github", run: github },
  { name: "stackoverflow", run: stackexchange },
  { name: "wikipedia", run: wikipedia },
  { name: "arxiv", run: arxiv },
];

export interface SearchOutcome {
  results: SearchResult[];
  backend: string;
  /** Backends tried and why they were rejected — surfaced for debugging. */
  tried: string[];
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

/**
 * Three tiers, in order:
 *
 *   1. A keyed general-web provider, if one is configured. Best coverage.
 *   2. A scraped general-web engine. Free, but all of them block datacenter IPs
 *      — kept because a self-hosted or local deployment is not blocked.
 *   3. The keyless specialist APIs, AGGREGATED rather than raced. Individually
 *      narrow; together they cover current tooling (HN, GitHub), concrete
 *      problems (Stack Overflow), background (Wikipedia) and research (arXiv).
 *      They run in parallel and their results are merged, because breadth is
 *      exactly what this tier lacks on its own.
 */
export async function webSearchDetailed(query: string): Promise<SearchOutcome> {
  const tried: string[] = [];

  for (const tier of [KEYED, KEYLESS_WEB]) {
    for (const b of tier) {
      try {
        const results = await b.run(query);
        if (results.length > 0) return { results, backend: b.name, tried };
        tried.push(`${b.name}: 0 results`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // "no key" is configuration, not failure — do not shout about it.
        tried.push(`${b.name}: ${msg}`);
      }
    }
  }

  const settled = await Promise.allSettled(SPECIALIST.map((b) => b.run(query)));
  const merged: SearchResult[] = [];
  const used: string[] = [];
  settled.forEach((r, i) => {
    const name = SPECIALIST[i]!.name;
    if (r.status === "fulfilled" && r.value.length > 0) {
      used.push(name);
      merged.push(...r.value);
    } else {
      tried.push(
        `${name}: ${r.status === "rejected" ? String(r.reason).slice(0, 60) : "0 results"}`,
      );
    }
  });

  if (merged.length > 0) {
    // Interleave so one prolific source cannot crowd the others out of the top.
    const bySource = new Map<string, SearchResult[]>();
    settled.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.length > 0)
        bySource.set(SPECIALIST[i]!.name, r.value);
    });
    const interleaved: SearchResult[] = [];
    for (let i = 0; i < 6; i++) {
      for (const list of bySource.values())
        if (list[i]) interleaved.push(list[i]!);
    }
    return {
      results: dedupe(interleaved).slice(0, 12),
      backend: used.join("+"),
      tried,
    };
  }

  return { results: [], backend: "none", tried };
}

export async function webSearch(query: string): Promise<SearchResult[]> {
  const { results, tried } = await webSearchDetailed(query);
  if (results.length === 0)
    throw new Error(`all search backends failed — ${tried.join("; ")}`);
  return results;
}

// ── Fetching a page the model chose ─────────────────────────────────────────
//
// The URL comes from a model, which in turn got it from a search result or from
// a page it just read — i.e. from the open internet. This function must
// therefore treat the URL as hostile input, not as a trusted parameter.

/** Hostnames that must never be fetched: this runs server-side, so a URL
 *  pointing inward reaches things the browser could not. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa")
  )
    return true;
  // IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (h === "::1" || h === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  // IPv4-mapped IPv6 (::ffff:169.254.169.254) — check the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  const v4 = mapped ? mapped[1]! : h;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Reject a URL before any request is made. Returns the reason, or null if ok. */
export function rejectUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid absolute URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return `unsupported scheme "${u.protocol}" — only http and https can be fetched`;
  if (isBlockedHost(u.hostname))
    return "refusing to fetch a private or loopback address";
  return null;
}

/** Read a response body with a hard byte ceiling, so one enormous page cannot
 *  exhaust the function's memory before the length is even known. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes * 4)
    throw new Error(`response too large (${Math.round(declared / 1024)} KB)`);
  const body = res.body;
  if (!body) return (await res.text()).slice(0, maxBytes);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c.subarray(0, Math.min(c.byteLength, total - at)), at);
    at += c.byteLength;
    if (at >= total) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

/** The page title, for citing a source by its name rather than by its URL. */
export function extractTitle(html: string): string | undefined {
  const og =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(
      html,
    );
  const t = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  const raw = t?.[1] ?? og?.[1];
  if (!raw) return undefined;
  const clean = decodeEntities(raw.replace(/\s+/g, " ")).trim();
  return clean || undefined;
}

/**
 * HTML → readable text.
 *
 * The old version deleted every tag and collapsed all whitespace into single
 * spaces, which handed the model one enormous line where the navigation, the
 * cookie banner, the article and the footer were indistinguishable. Models
 * quote such text badly and attribute it worse. Here: chrome is dropped rather
 * than flattened, `<article>`/`<main>` wins when a page marks it, and block
 * boundaries survive as newlines so paragraphs and list items stay separable.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|canvas|iframe|template|select)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    );

  const main =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(s) ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(s);
  // Only trust the marked-up main content when there is a real amount of it —
  // some pages wrap a teaser in <main> and put the article beside it.
  if (main && (main[1]?.length ?? 0) > 500) s = main[1]!;

  s = s.replace(
    /<(nav|header|footer|aside|form|figure)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );

  const text = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|section|li|tr|h[1-6]|blockquote|pre|td|th)>/gi, "\n")
    // Quoted attribute values are skipped explicitly rather than treating the
    // first ">" as the end of the tag. Modern pages hide JSON in attributes —
    // Wikipedia's infobox does — and a naive /<[^>]+>/ ends the tag inside that
    // JSON, spilling `}}"}},"i":0}}]}'>` into the text the model then reads as
    // prose.
    .replace(/<[a-zA-Z!/?](?:[^>"']|"[^"]*"|'[^']*')*>/g, " ");

  return decodeEntities(text)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface FetchOutcome {
  text: string;
  /** The page's own title, when it has one — used to cite it by name. */
  title?: string;
  /** Where the redirect chain actually ended, which is what was really read. */
  finalUrl: string;
  truncated: boolean;
}

const MAX_FETCH_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

/**
 * Fetch a page and return its readable text.
 *
 * Redirects are followed MANUALLY: `redirect: "follow"` would let a public URL
 * bounce the request to a private address after the pre-flight check had
 * already passed, which is the standard way an SSRF guard gets walked around.
 * Every hop is re-validated.
 */
export async function webFetchDetailed(url: string): Promise<FetchOutcome> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const reason = rejectUrl(current);
    if (reason) throw new Error(reason);
    const res = await fetch(current, {
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`HTTP ${res.status} with no location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // A PDF or an image read as UTF-8 becomes mojibake, and a model handed
    // mojibake does not report a failure — it invents plausible prose and cites
    // the URL. Refusing outright is strictly more honest.
    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ctype && !/text\/|html|xml|json|javascript/.test(ctype)) {
      throw new Error(
        `cannot read ${ctype.split(";")[0]} as text — this URL is not a web page`,
      );
    }

    const body = await readCapped(res, MAX_FETCH_BYTES);
    const text = /json|javascript/.test(ctype)
      ? body
      : /text\/plain/.test(ctype)
        ? decodeEntities(body)
        : htmlToText(body);

    if (text.trim().length < 120) {
      throw new Error(
        "page returned almost no readable text (it may require JavaScript, " +
          "or the request was challenged)",
      );
    }
    return {
      text: clip(text),
      title: extractTitle(body),
      finalUrl: current,
      truncated: text.length > MAX_OUTPUT,
    };
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

/** Text-only convenience wrapper, kept for callers that want just the body. */
export async function webFetch(url: string): Promise<string> {
  return (await webFetchDetailed(url)).text;
}
