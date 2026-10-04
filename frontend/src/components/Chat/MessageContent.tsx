import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

const sanitizeSchema = {
  tagNames: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'div', 'span', 'br', 'hr',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
    'code', 'pre', 'kbd', 'samp', 'var',
    'blockquote', 'q', 'cite',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'a', 'img',
    'sub', 'sup', 'mark', 'small'
  ],
  attributes: {
    'a': ['href', 'title', 'target', 'rel'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'code': ['className', 'class', 'language'],
    'pre': ['className', 'class', 'language'],
    'span': ['className', 'class'],
  },
  protocolAllowlist: ['http', 'https', 'mailto']
};

function preprocessMarkdown(content: string): string {
  // 保护代码块和行内代码，避免内部内容被预处理破坏
  const codeBlocks: string[] = [];
  const placeholder = (match: string) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  };

  let result = content
    // 先提取代码块（```...```）
    .replace(/```[\s\S]*?```/g, placeholder)
    // 再提取行内代码（`...`）
    .replace(/`[^`\n]+`/g, placeholder);

  result = result
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .replace(/([^\n])\n([^\n])/g, '$1  \n$2')
    .replace(/^「> (.+?)」$/gm, '> $1')
    // @提及：只匹配连续非空格字符，避免误匹配邮箱和包含空格的文本
    .replace(/(^|[^a-zA-Z0-9_.\u4e00-\u9fff-])@([a-zA-Z0-9_.\u4e00-\u9fff-]+)/g, '$1**@$2**');

  // 还原代码块
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)]);

  return result;
}

interface MessageContentProps {
  content: string;
  contentType?: string;
  isUser: boolean;
  isStreaming?: boolean;
  /** Artifact review must never silently truncate the accepted body. */
  alwaysExpanded?: boolean;
}

export const MessageContent = React.memo(function MessageContent({
  content,
  contentType,
  isUser,
  isStreaming,
  alwaysExpanded = false
}: MessageContentProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const COLLAPSE_THRESHOLD = 600;
  const USER_COLLAPSE_THRESHOLD = 2000;

  const processedContent = useMemo(() => {
    if (contentType === 'text' || !contentType) {
      return preprocessMarkdown(content);
    }
    return content;
  }, [content, contentType]);

  const collapseThreshold = isUser ? USER_COLLAPSE_THRESHOLD : COLLAPSE_THRESHOLD;
  const shouldCollapse = !alwaysExpanded && processedContent.length > collapseThreshold && !isExpanded && !isStreaming;
  const displayContent = shouldCollapse
    ? processedContent.substring(0, collapseThreshold) + '...'
    : processedContent;

  const markdownComponents = useMemo(() => ({
    a: ({ node: _node, children, href, title, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown; children?: React.ReactNode }) => (
      <a {...rest} href={href} title={title} target="_blank" rel="noopener noreferrer nofollow">{children}</a>
    ),
  }), []);

  if (contentType === 'code') {
    return (
      <pre className="whitespace-pre-wrap font-mono select-text" style={{ fontSize: 'var(--chat-message-font-size)' }}>
        {content}
      </pre>
    );
  }

  return (
    <div className="markdown-content select-text">
      {isStreaming && !content ? (
        <div className="flex items-center gap-1.5 py-1">
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      ) : (
        <>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
            components={markdownComponents}
          >
            {displayContent}
          </ReactMarkdown>
          {isStreaming && content && (
            <span className="inline-block w-0.5 h-[1.1em] bg-accent ml-0.5 animate-pulse align-text-bottom rounded-sm" />
          )}
        </>
      )}
      {!alwaysExpanded && processedContent.length > collapseThreshold && !isStreaming && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className="mt-1 text-xs text-accent hover:text-accent-hover transition-colors font-medium"
        >
          {isExpanded ? '收起 ↑' : '展开全文 ↓'}
        </button>
      )}
    </div>
  );
});
