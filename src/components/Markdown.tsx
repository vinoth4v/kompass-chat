"use client";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMath } from "@/lib/mathMarkdown";
import { CodeBlock } from "./CodeBlock";

// One renderer for every assistant answer in the app.
//
// There were three ReactMarkdown call sites with three different plugin sets:
// chat highlighted code, the council did not, and none of them rendered
// mathematics — so the same answer looked different depending on which mode
// produced it, and a derivation rendered as raw LaTeX everywhere.

const components = {
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code: CodeBlock,
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

const remarkPlugins = [remarkGfm, remarkMath];
// throwOnError: false is load-bearing. Free models emit invalid LaTeX often
// enough that a throwing renderer would blank the whole answer over one bad
// macro; KaTeX instead renders the offending source in red and carries on.
const rehypePlugins = [rehypeHighlight, [rehypeKatex, { throwOnError: false, strict: false }]] as const;

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins as never}
      components={components}
    >
      {normalizeMath(children)}
    </ReactMarkdown>
  );
}
