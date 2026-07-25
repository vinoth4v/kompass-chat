import { describe, it, expect } from "vitest";
import {
  decodeEntities,
  extractTitle,
  htmlToText,
  isBlockedHost,
  rejectUrl,
} from "./scrape";

describe("decodeEntities", () => {
  it("decodes the numeric apostrophe instead of eating it", () => {
    // The old implementation mapped every numeric entity to a space, so this
    // read "Gandhi s life" in every snippet the models were given.
    expect(decodeEntities("Gandhi&#39;s life")).toBe("Gandhi's life");
  });

  it("decodes hex entities, which the old regex could not match at all", () => {
    expect(decodeEntities("don&#x2019;t")).toBe("don’t");
  });

  it("decodes the named entities that actually occur", () => {
    expect(decodeEntities("a&nbsp;b &amp; c &mdash; d &hellip;")).toBe(
      "a b & c — d …",
    );
  });

  it("leaves unknown and malformed entities alone rather than mangling them", () => {
    expect(decodeEntities("&notarealentity; 5 &lt; 10")).toBe(
      "&notarealentity; 5 < 10",
    );
    expect(decodeEntities("&#99999999;")).toBe("&#99999999;");
  });

  it("does not treat a bare ampersand as an entity", () => {
    expect(decodeEntities("Tom & Jerry")).toBe("Tom & Jerry");
  });
});

describe("htmlToText", () => {
  it("drops chrome and keeps the article", () => {
    const html = `
      <html><head><style>.x{color:red}</style></head><body>
        <nav>Home About Contact</nav>
        <header>Cookie banner</header>
        <article><p>Gandhi was born in 1869.</p><p>He trained as a lawyer.</p></article>
        <footer>Copyright</footer>
        <script>tracking()</script>
      </body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Gandhi was born in 1869.");
    expect(text).toContain("He trained as a lawyer.");
    expect(text).not.toContain("Home About Contact");
    expect(text).not.toContain("Cookie banner");
    expect(text).not.toContain("tracking()");
    expect(text).not.toContain("color:red");
  });

  it("keeps paragraph boundaries, so quoting a page cannot merge two claims", () => {
    const text = htmlToText("<p>First claim.</p><p>Second claim.</p>");
    expect(text).toBe("First claim.\nSecond claim.");
  });

  it("marks list items", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toContain("• one");
  });

  it("does not spill JSON out of an attribute containing '>'", () => {
    // Verified against the live Wikipedia article on Gandhi, whose infobox
    // carries JSON in a data attribute. A naive /<[^>]+>/ ended the tag inside
    // that JSON and left `}}"}},"i":0}}]}'>` sitting in the text.
    const html = `<span data-x='{"a":{"b":">"}}'>Real text.</span>`;
    const text = htmlToText(html);
    expect(text).toBe("Real text.");
    expect(text).not.toContain('"b"');
  });

  it("ignores a tiny <main> rather than throwing the page away", () => {
    // Some pages put a teaser in <main> and the body beside it. Trusting it
    // blindly would discard the actual content.
    const html = `<main><p>Teaser.</p></main><div><p>${"The real body. ".repeat(60)}</p></div>`;
    expect(htmlToText(html)).toContain("The real body.");
  });
});

describe("extractTitle", () => {
  it("reads and decodes the page title", () => {
    expect(extractTitle("<title>Gandhi&#39;s life &amp; times</title>")).toBe(
      "Gandhi's life & times",
    );
  });
  it("returns undefined when there is none", () => {
    expect(extractTitle("<p>no title here</p>")).toBeUndefined();
  });
});

describe("isBlockedHost", () => {
  it("blocks loopback, private ranges and cloud metadata", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:169.254.169.254",
      "db.internal",
      "printer.local",
    ]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });

  it("allows ordinary public hosts, including near-misses", () => {
    for (const h of [
      "example.com",
      "en.wikipedia.org",
      "8.8.8.8",
      "172.32.0.1", // just outside the private block
      "192.169.0.1",
      "11.0.0.1",
    ]) {
      expect(isBlockedHost(h), h).toBe(false);
    }
  });
});

describe("rejectUrl", () => {
  it("accepts a normal page", () => {
    expect(rejectUrl("https://en.wikipedia.org/wiki/Gandhi")).toBeNull();
  });
  it("rejects non-http schemes", () => {
    expect(rejectUrl("file:///etc/passwd")).toMatch(/scheme/);
    expect(rejectUrl("data:text/html,hi")).toMatch(/scheme/);
  });
  it("rejects internal addresses", () => {
    expect(rejectUrl("http://169.254.169.254/latest/meta-data/")).toMatch(
      /private or loopback/,
    );
    expect(rejectUrl("http://localhost:3000/admin")).toMatch(
      /private or loopback/,
    );
  });
  it("rejects nonsense", () => {
    expect(rejectUrl("not a url")).toMatch(/valid absolute URL/);
  });
});
