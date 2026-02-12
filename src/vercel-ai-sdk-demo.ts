/**
 * AI Chatbot Demo with Next.js + Vercel AI SDK
 *
 * This demo creates a chatbot application using:
 * - Next.js App Router for the frontend
 * - Pages Router API routes for the streaming endpoint
 * - Vercel AI SDK with useChat hook
 * - OpenAI (via CORS proxy for browser environment)
 */

import { VirtualFS } from './virtual-fs';

/**
 * Package.json for the AI chatbot app
 */
const PACKAGE_JSON = {
  name: "ai-chatbot-demo",
  version: "0.1.0",
  private: true,
  scripts: {
    dev: "next dev",
    build: "next build",
    start: "next start",
  },
  dependencies: {
    "next": "^14.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "ai": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0",
  },
  devDependencies: {
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "typescript": "^5.9.3",
  }
};

/**
 * Create the AI chatbot project structure in the virtual filesystem
 */
export function createAIChatbotProject(vfs: VirtualFS): void {
  // Create package.json
  vfs.writeFileSync('/package.json', JSON.stringify(PACKAGE_JSON, null, 2));

  // Create directories - App Router + Pages Router (for API)
  vfs.mkdirSync('/app', { recursive: true });
  vfs.mkdirSync('/pages/api', { recursive: true });
  vfs.mkdirSync('/public', { recursive: true });

  // Create TypeScript config
  vfs.writeFileSync('/tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: "es5",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      paths: {
        "@/*": ["./*"]
      }
    },
    include: ["**/*.ts", "**/*.tsx"],
    exclude: ["node_modules"]
  }, null, 2));

  // Create global CSS with Tailwind
  vfs.writeFileSync('/app/globals.css', `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  min-height: 100vh;
}

.chat-container {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
}

.message-bubble {
  padding: 1rem;
  border-radius: 1rem;
  margin-bottom: 0.75rem;
  max-width: 80%;
  animation: fadeIn 0.3s ease-out;
}

.message-user {
  background: #3b82f6;
  color: white;
  margin-left: auto;
  border-bottom-right-radius: 0.25rem;
}

.message-assistant {
  background: white;
  color: #1f2937;
  margin-right: auto;
  border-bottom-left-radius: 0.25rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.loading-dots::after {
  content: '';
  animation: dots 1.5s steps(5, end) infinite;
}

@keyframes dots {
  0%, 20% { content: '.'; }
  40% { content: '..'; }
  60%, 100% { content: '...'; }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.input-container {
  position: sticky;
  bottom: 0;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(10px);
  border-radius: 1rem;
  padding: 1rem;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.1);
}
`);

  // Create root layout (App Router)
  vfs.writeFileSync('/app/layout.tsx', `import React from 'react';
import './globals.css';

export const metadata = {
  title: 'AI Chatbot Demo',
  description: 'A chatbot demo using Next.js and Vercel AI SDK',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="bg-white/10 backdrop-blur-sm border-b border-white/20">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <span>🤖</span>
            AI Chatbot Demo
          </h1>
          <p className="text-white/70 text-sm mt-1">
            Powered by Vercel AI SDK + OpenAI
          </p>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
`);

  // Create home page with chat UI (App Router)
  vfs.writeFileSync('/app/page.tsx', `"use client";

import React from 'react';
import { useChat } from 'ai/react';

// Get the virtual base path for API calls
// The iframe runs at /__virtual__/PORT/ so we need to prefix API calls
function getApiUrl(path: string): string {
  const match = window.location.pathname.match(/^(\\/__virtual__\\/\\d+)/);
  if (match) {
    return match[1] + path;
  }
  return path;
}

export default function ChatPage() {
  // Use the correct API URL based on the virtual base path
  const apiUrl = React.useMemo(() => getApiUrl('/api/chat'), []);

  const { messages, input, handleInputChange, handleSubmit, isLoading, error } = useChat({
    api: apiUrl,
    onResponse: (response) => {
      console.log('[useChat] onResponse - status:', response.status, 'headers:', Object.fromEntries(response.headers.entries()));
    },
    onFinish: (message) => {
      console.log('[useChat] onFinish - message:', message);
    },
    onError: (err) => {
      console.error('[useChat] onError:', err);
    },
  });

  // Debug: log messages changes
  React.useEffect(() => {
    console.log('[ChatPage] messages updated:', messages.length, messages.map(m => ({ role: m.role, contentLength: m.content.length })));
  }, [messages]);

  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="chat-container">
      {/* Welcome message when no messages */}
      {messages.length === 0 && (
        <div className="text-center py-12">
          <div className="text-6xl mb-4">💬</div>
          <h2 className="text-2xl font-semibold text-white mb-2">
            Start a conversation
          </h2>
          <p className="text-white/70 max-w-md mx-auto">
            Type a message below to chat with the AI assistant.
            Your conversation will stream in real-time.
          </p>
        </div>
      )}

      {/* Messages list */}
      <div className="space-y-4 pb-32">
        {messages.map((message) => (
          <div
            key={message.id}
            className={\`message-bubble \${
              message.role === 'user' ? 'message-user' : 'message-assistant'
            }\`}
          >
            <div className="flex items-start gap-3">
              <span className="text-lg">
                {message.role === 'user' ? '👤' : '🤖'}
              </span>
              <div className="flex-1">
                <p className="font-medium text-sm opacity-70 mb-1">
                  {message.role === 'user' ? 'You' : 'Assistant'}
                </p>
                <div className="whitespace-pre-wrap">{message.content}</div>
              </div>
            </div>
          </div>
        ))}

        {/* Loading indicator - only show when waiting for response to start streaming */}
        {isLoading && messages.length > 0 && messages[messages.length - 1].role === 'user' && (
          <div className="message-bubble message-assistant">
            <div className="flex items-start gap-3">
              <span className="text-lg">🤖</span>
              <div className="flex-1">
                <p className="font-medium text-sm opacity-70 mb-1">Assistant</p>
                <div className="loading-dots text-gray-500">Thinking</div>
              </div>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="message-bubble bg-red-100 text-red-700">
            <div className="flex items-start gap-3">
              <span className="text-lg">⚠️</span>
              <div>
                <p className="font-medium">Error</p>
                <p>{error.message}</p>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input form */}
      <div className="input-container">
        <form onSubmit={handleSubmit} className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={handleInputChange}
            placeholder="Type your message..."
            disabled={isLoading}
            className="flex-1 px-4 py-3 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:cursor-not-allowed"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Sending
              </span>
            ) : (
              'Send'
            )}
          </button>
        </form>
        <p className="text-xs text-gray-400 mt-2 text-center">
          Press Enter to send • Streaming responses powered by Vercel AI SDK
        </p>
      </div>
    </div>
  );
}
`);

  // Create API route for chat (Pages Router - works in our environment)
  // Uses CORS proxy to call OpenAI from browser
  vfs.writeFileSync('/pages/api/chat.ts', `/**
 * AI Chat API Route
 *
 * This endpoint handles chat requests using the Vercel AI SDK.
 * It uses a CORS proxy (corsproxy.io) to make OpenAI API calls
 * from the browser environment.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

// Get API key from environment and sanitize it
const getApiKey = () => {
  // Debug: log what we're seeing
  console.log('[API /chat] getApiKey called');
  console.log('[API /chat] typeof process:', typeof process);
  console.log('[API /chat] process.env keys:', typeof process !== 'undefined' && process.env ? Object.keys(process.env) : 'N/A');

  // Check process.env (set by demo entry)
  if (typeof process !== 'undefined' && process.env?.OPENAI_API_KEY) {
    const rawKey = process.env.OPENAI_API_KEY;
    console.log('[API /chat] Raw key length:', rawKey?.length);
    console.log('[API /chat] Raw key starts with:', rawKey?.substring(0, 10));
    console.log('[API /chat] Raw key ends with:', rawKey?.substring(rawKey.length - 10));

    // Sanitize: trim whitespace and remove any non-ASCII characters
    // This prevents "String contains non ISO-8859-1 code point" errors
    const key = rawKey
      .trim()
      .replace(/[^\x00-\x7F]/g, ''); // Remove non-ASCII characters

    console.log('[API /chat] Sanitized key length:', key?.length);
    return key || null;
  }
  console.log('[API /chat] No OPENAI_API_KEY found in process.env');
  return null;
};

// CORS proxy for OpenAI API calls from browser
const CORS_PROXY = 'https://corsproxy.io/?';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return res.status(500).json({
      error: 'OpenAI API key not configured. Please enter your API key in the demo panel.'
    });
  }

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    // Format messages for OpenAI API
    const formattedMessages = messages.map((m: any) => ({
      role: m.role,
      content: m.content,
    }));

    // Make request to OpenAI via CORS proxy
    const response = await fetch(CORS_PROXY + encodeURIComponent(OPENAI_API_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer \${apiKey}\`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: formattedMessages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', errorText);
      return res.status(response.status).json({
        error: \`OpenAI API error: \${response.statusText}\`
      });
    }

    // Set up streaming response headers
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    // Stream the response using AI SDK data stream format
    // Format: 0:"text chunk"\\n (text deltas)
    const reader = response.body?.getReader();
    if (!reader) {
      return res.status(500).json({ error: 'Failed to get response stream' });
    }

    console.log('[API /chat] Starting to stream response...');
    const decoder = new TextDecoder();
    let buffer = '';
    let chunkCount = 0;

    // Collect all chunks first (CORS proxy may buffer entire response)
    const pendingChunks: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('[API /chat] OpenAI stream done');
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('[API /chat] Received [DONE] from OpenAI');
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              // AI SDK data stream format: 0:"text"\\n
              const chunk = \`0:"\${content.replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\n')}"\\n\`;
              pendingChunks.push(chunk);
            }
          } catch (e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    }

    console.log('[API /chat] Collected', pendingChunks.length, 'chunks, streaming with delays...');

    // Helper to create delay
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Stream chunks with delays to ensure they arrive separately
    // The CORS proxy buffers the entire OpenAI response, so we simulate streaming
    // by writing chunks with delays. 50ms gives the message channel time to process
    // each chunk before the next one arrives.
    for (const chunk of pendingChunks) {
      chunkCount++;
      console.log('[API /chat] Writing chunk', chunkCount);
      res.write(chunk);
      // Longer delay to ensure message channel processes each chunk separately
      await delay(50);
    }

    // End the stream with finish reason
    console.log('[API /chat] Writing finish message, total chunks:', chunkCount);
    res.write('d:{"finishReason":"stop"}\\n');
    res.end();

  } catch (error) {
    console.error('Chat API error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
}
`);

  // Create public files
  vfs.writeFileSync('/public/favicon.ico', 'favicon placeholder');
  vfs.writeFileSync('/public/robots.txt', 'User-agent: *\nAllow: /');
}

// Export for use in HTML demos
export { PACKAGE_JSON };
