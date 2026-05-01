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
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .replace(/([^\n])\n([^\n])/g, '$1  \n$2')
    .replace(/^「> (.+?)」$/gm, '> $1')
    .replace(/@([a-zA-Z0-9_.\u4e00-\u9fff\s-]+)/g, '**@$1**');
}

interface MessageContentProps {
  content: string;
  contentType?: string;
  isUser: boolean;
  isStreaming?: boolean;
}

export const MessageContent = React.memo(function MessageContent({
  content,
  contentType,
  isUser,
  isStreaming
}: MessageContentProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const COLLAPSE_THRESHOLD = 600;

  const processedContent = useMemo(() => {
    if (contentType === 'text' || !contentType) {
      return preprocessMarkdown(content);
    }
    return content;
  }, [content, contentType]);

  const shouldCollapse = !isUser && processedContent.length > COLLAPSE_THRESHOLD && !isExpanded;
  const displayContent = shouldCollapse
    ? processedContent.substring(0, COLLAPSE_THRESHOLD) + '...'
    : processedContent;

  if (contentType === 'code') {
    return (
      <pre className="whitespace-pre-wrap font-mono select-text" style={{ fontSize: 'var(--chat-message-font-size)' }}>
        {content}
      </pre>
    );
  }

  return (
    <div className="markdown-content select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
      >
        {displayContent}
      </ReactMarkdown>
      {!isUser && processedContent.length > COLLAPSE_THRESHOLD && !isStreaming && (
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
