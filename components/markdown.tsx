"use client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy } from "lucide-react";
export function MarkdownText({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        pre: ({ children }) => (
          <div className="code-block">
            <button
              className="code-copy"
              aria-label="Copy code"
              onClick={(e) => {
                const code =
                  e.currentTarget.parentElement?.querySelector(
                    "code",
                  )?.textContent;
                if (code) void navigator.clipboard.writeText(code);
              }}
            >
              <Copy size={14} /> Copy
            </button>
            <pre>{children}</pre>
          </div>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}
