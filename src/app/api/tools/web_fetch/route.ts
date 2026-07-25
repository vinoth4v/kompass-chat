import { NextResponse } from "next/server";
import { rejectUrl, webFetchDetailed } from "@/lib/scrape";

export async function POST(req: Request) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json(
      { error: "url (string) is required" },
      { status: 400 },
    );
  }
  // Rejected before the request is made, and reported as a 400 rather than a
  // 502: a model pointing this route at localhost is a bad request, not an
  // upstream failure, and the distinction matters when reading logs.
  const refusal = rejectUrl(body.url);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

  try {
    const { text, title, finalUrl, truncated } = await webFetchDetailed(
      body.url,
    );
    return NextResponse.json({ text, title, finalUrl, truncated });
  } catch (e) {
    return NextResponse.json(
      { error: String(e instanceof Error ? e.message : e).slice(0, 300) },
      { status: 502 },
    );
  }
}
