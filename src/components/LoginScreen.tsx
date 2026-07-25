"use client";
import { LogoMark } from "./Logo";

/**
 * 32 bytes from crypto.getRandomValues, hex-encoded. Deliberately not derived
 * from anything the user types — a passphrase-shaped secret is exactly what
 * makes these guessable — and never transmitted: this page has no backend.
 */
function randomSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
import {
  AlertCircle,
  ArrowRight,
  Loader2,
  Quote,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { verifyConnection } from "@/lib/kompassClient";

export function LoginScreen({
  onConnected,
}: {
  onConnected: (workerUrl: string, bearer: string) => void;
}) {
  const [workerUrl, setWorkerUrl] = useState("");
  const [bearer, setBearer] = useState("");
  const [generated, setGenerated] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "checking" | "error">("idle");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = workerUrl.trim().replace(/\/$/, "");
    const token = bearer.trim();
    if (!url || !token) return;
    setStatus("checking");
    setError("");
    const result = await verifyConnection(url, token);
    if (result.ok) {
      onConnected(url, token);
    } else {
      setStatus("error");
      setError(result.error);
    }
  };

  return (
    <div className="min-h-dvh bg-bg px-4 py-10 text-ink sm:py-16">
      <div className="mx-auto grid w-full max-w-5xl gap-10 lg:grid-cols-[1.1fr_minmax(0,26rem)] lg:gap-14">
        {/* ── Pitch. A first-time visitor has no idea what this is or why it is
            not just another chat box, so say it before asking for a token. ── */}
        <div className="flex flex-col justify-center">
          <LogoMark size={40} className="text-ink" />
          <h1 className="mt-5 text-3xl font-semibold tracking-[-0.03em] text-ink sm:text-4xl">
            Kompass <span className="font-normal text-ink-muted">AI</span>
          </h1>
          <p className="mt-3 max-w-xl text-[1.02rem] leading-relaxed text-ink-secondary">
            Chat, image generation, deep web research and a multi-agent council
            — running on free models through a gateway that lives on{" "}
            <em>your</em> Cloudflare account.
          </p>

          <ul className="mt-8 space-y-5">
            {[
              {
                icon: <ShieldCheck className="h-4 w-4" />,
                title: "Your keys never reach us",
                body: "This page is static. Your token is stored in this browser and sent straight to your own Worker — there is no backend here to send it to.",
              },
              {
                icon: <Zap className="h-4 w-4" />,
                title: "Works before you sign up for anything",
                body: "A fresh gateway answers using Cloudflare Workers AI on your own account. Provider keys add capacity later; they are not a prerequisite.",
              },
              {
                icon: <Quote className="h-4 w-4" />,
                title: "It only cites what it actually read",
                body: "Sources are recorded when a fetch succeeds, never from what a model claims. An answer here has a real source behind it or shows none.",
              },
              {
                icon: <Users className="h-4 w-4" />,
                title: "A council, not a single opinion",
                body: "Several models research the same question in parallel, then a judge weighs them and names where they disagree — instead of one model sounding confident alone.",
              },
            ].map((f) => (
              <li key={f.title} className="flex gap-3.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  {f.icon}
                </span>
                <div>
                  <div className="text-[0.92rem] font-medium text-ink">
                    {f.title}
                  </div>
                  <p className="mt-0.5 text-[0.85rem] leading-relaxed text-ink-muted">
                    {f.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-8 text-[0.78rem] text-ink-faint">
            Open source ·{" "}
            <a
              href="https://github.com/vinoth4v/kompass-chat"
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline"
            >
              this app
            </a>{" "}
            ·{" "}
            <a
              href="https://github.com/vinoth4v/kompass"
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline"
            >
              the gateway
            </a>
          </p>
        </div>

        <div className="w-full max-w-sm lg:justify-self-end">
          <div className="mb-8 flex flex-col items-center gap-3 text-center lg:hidden">
            <LogoMark size={44} className="text-ink" />
            <div>
              <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">
                Kompass <span className="font-normal text-ink-muted">AI</span>
              </h1>
              <p className="mt-1 text-sm text-ink-muted">
                Sign in with your Kompass gateway
              </p>
            </div>
          </div>

          <form
            onSubmit={submit}
            className="space-y-3 rounded-2xl border border-line bg-white/[0.03] p-5"
          >
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-secondary">
                Worker URL
              </label>
              <input
                value={workerUrl}
                onChange={(e) => setWorkerUrl(e.target.value)}
                placeholder="https://kompass.<you>.workers.dev"
                className="w-full rounded-lg border border-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-500"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-secondary">
                Bearer token
              </label>
              <input
                type="password"
                value={bearer}
                onChange={(e) => setBearer(e.target.value)}
                placeholder="KOMPASS_BEARER"
                className="w-full rounded-lg border border-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
            </div>

            {status === "error" && (
              <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={
                status === "checking" || !workerUrl.trim() || !bearer.trim()
              }
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "checking" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <>
                  Connect <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          <p className="mt-4 text-center text-[0.75rem] leading-relaxed text-ink-muted">
            Your bearer is stored only in this browser and sent directly to your
            own Worker — never to a third party.
          </p>

          {/* A chat-only user has to be able to get from nothing to chatting
            without leaving this app, and without installing anything. */}
          <div className="mt-6 rounded-xl border border-line bg-surface p-4">
            <p className="text-[0.82rem] font-medium text-ink">
              Don&rsquo;t have a gateway yet?
            </p>
            <p className="mt-1 text-[0.75rem] leading-relaxed text-ink-muted">
              Deploy one to your own Cloudflare account — nothing to install,
              and no AI provider signup: it answers using Cloudflare Workers AI
              from the moment it exists. Needs a GitHub or GitLab account too,
              because Cloudflare&rsquo;s deploy button works by cloning the repo
              into your own git account.
            </p>
            <a
              href="https://deploy.workers.cloudflare.com/?url=https://github.com/vinoth4v/kompass"
              target="_blank"
              rel="noreferrer noopener"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[0.8rem] font-medium text-accent-contrast transition hover:bg-accent-hover"
            >
              Deploy to Cloudflare <ArrowRight size={14} />
            </a>

            <div className="mt-4 border-t border-line pt-3">
              <p className="text-[0.75rem] text-ink-secondary">
                Cloudflare will ask for two secrets. Generate them here — they
                are created in this browser and never sent anywhere.
              </p>
              {(
                [
                  ["KOMPASS_BEARER", "signs you in"],
                  [
                    "KOMPASS_MASTER_KEY",
                    "encrypts provider keys you add later",
                  ],
                ] as const
              ).map(([name, what]) => (
                <div key={name} className="mt-2">
                  <label className="text-[0.7rem] text-ink-muted">
                    <span className="font-mono text-ink-secondary">{name}</span>{" "}
                    — {what}
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      readOnly
                      value={generated[name] ?? ""}
                      placeholder="click generate"
                      className="min-w-0 flex-1 rounded-lg border border-line bg-elevated px-2.5 py-1.5 font-mono text-[0.7rem] text-ink outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const v = randomSecret();
                        setGenerated((g) => ({ ...g, [name]: v }));
                        void navigator.clipboard.writeText(v).catch(() => {});
                      }}
                      className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[0.72rem] text-ink-secondary transition hover:bg-surface-hover hover:text-ink"
                    >
                      {generated[name] ? "Copied" : "Generate"}
                    </button>
                  </div>
                </div>
              ))}
              <p className="mt-2 text-[0.68rem] leading-relaxed text-ink-faint">
                Save both. Losing the bearer means redeploying; losing the
                master key only means re-entering provider keys, since it is
                what decrypts them.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
