# 🧭 Kompass AI

**A chat app for your own free-model gateway.** Chat, image generation, web research and a
multi-agent AI Council — all running through a [Kompass](https://github.com/vinoth4v/kompass)
Worker deployed to _your_ Cloudflare account.

**Live:** [kompass-chat.vercel.app](https://kompass-chat.vercel.app) · MIT

---

## What makes it different

**Your keys never leave your infrastructure.** This app is static. It has no backend session, no
database and no account system. Your bearer token lives in your browser's localStorage and is sent
directly to your own Worker — never to this app's server. The only server-side routes here are two
web-scraping helpers (`/api/tools/*`), and they never receive a credential.

**It works before you sign up for anything.** A freshly deployed Kompass answers using Cloudflare
Workers AI on your own account, because a Workers AI _binding_ needs no API key at all. Provider
keys are a capacity upgrade, not a prerequisite.

**Everything it cites, it actually read.** Sources are recorded at the moment a fetch or a data
lookup _succeeds_ — never from what a model claims it read. Models invent citations readily; an
answer here either has a real source behind it or shows none.

---

## Four modes

| Mode         | What it does                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**     | Ordinary conversation, with web access when the answer depends on current facts. Attach images, PDFs, code, CSV, JSON or logs and ask about them.         |
| **Image**    | Text-to-image through your gateway's free image chain.                                                                                                    |
| **Research** | A tool-use loop: searches, reads pages, and answers with citations.                                                                                       |
| **Council**  | Several models research the same question _independently and in parallel_, then a judge weighs them, names the disagreements, and synthesizes one answer. |

### The AI Council

The interesting one. It composes itself from your gateway's live health — measured success rate,
median latency, remaining quota — and seats **one model per provider**, so the agents don't compete
for the same rate limit. You don't pick the models; picking them badly is exactly what the planner
exists to prevent.

Failed seats stay visible rather than being hidden, because on free models a partial council is
normal, and you deserve to know an answer came from two analysts rather than four.

---

## Tools available to the models

Beyond `web_search` and `web_fetch`, models can reach structured sources directly — a number is
better than a page about the number:

| Tool            | Sources                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `get_news`      | Google News (headlines with outlet and date)                                                                                              |
| `get_data`      | weather (Open-Meteo), FX (ECB), stocks (Yahoo), crypto (CoinGecko), sports (ESPN), macro (World Bank)                                     |
| `get_reference` | PubMed, openFDA, ClinicalTrials.gov, USGS, Open Library, World Bank countries, npm/PyPI, NVD CVEs, Open Food Facts, Wikidata, MusicBrainz |

All keyless. See [SEARCH.md](./SEARCH.md) for the search backend chain, what is blocked from
datacenter IPs, and how to add an optional keyed provider.

---

## Getting started

You need a Kompass gateway. If you don't have one, the app's login screen has a
**Deploy to Cloudflare** button and generates the two secrets you'll be asked for.

Then enter your worker URL and bearer token, and you're in. Provider API keys can be added later
from **Settings → Model providers** — they're encrypted (AES-GCM) into your own Cloudflare KV and
never touch this app.

## Running it yourself

The hosted app is convenient, not privileged — it's the same static bundle. If you'd rather not
trust a page someone else hosts:

```sh
git clone https://github.com/vinoth4v/kompass-chat && cd kompass-chat
npm install
npm run dev          # http://localhost:3000
```

Deploy your own copy:

```sh
vercel link && vercel deploy --prod
```

Optional: set `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY` or `EXA_API_KEY` as environment
variables to improve web search. None are required — see [SEARCH.md](./SEARCH.md).

## Stack

Next.js 15 (App Router), React 19, Tailwind, `react-markdown`. No state management library, no
backend, no database.

---

**The gateway:** [github.com/vinoth4v/kompass](https://github.com/vinoth4v/kompass) ·
**Docs:** [kompass-iota.vercel.app/docs.html](https://kompass-iota.vercel.app/docs.html)
