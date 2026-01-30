/**
 * Sandbox Helpers - Generate files for deploying a cross-origin sandbox
 *
 * The sandbox runs on a different origin (e.g., myapp-sandbox.vercel.app)
 * to provide browser-enforced isolation from the main application.
 */

/**
 * HTML template for the sandbox page.
 * This loads just-node and handles postMessage communication with the parent.
 *
 * @param justNodeUrl - URL to load just-node from (e.g., unpkg, jsdelivr, or your CDN)
 */
export function getSandboxHtml(justNodeUrl = 'https://unpkg.com/just-node/dist/index.js'): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>just-node Sandbox</title>
</head>
<body>
<script type="module">
  import { VirtualFS, Runtime } from '${justNodeUrl}';

  let vfs = null;
  let runtime = null;
  let consoleCallback = null;

  // Handle messages from parent
  window.addEventListener('message', async (event) => {
    const { type, id, code, filename, vfsSnapshot, options, path, content } = event.data;

    try {
      switch (type) {
        case 'init':
          // Initialize VFS from snapshot
          vfs = VirtualFS.fromSnapshot(vfsSnapshot);

          // Create runtime with options
          runtime = new Runtime(vfs, {
            cwd: options?.cwd,
            env: options?.env,
            onConsole: (method, args) => {
              // Forward console to parent
              parent.postMessage({
                type: 'console',
                consoleMethod: method,
                consoleArgs: args,
              }, '*');
            },
          });
          break;

        case 'syncFile':
          // Sync file changes from parent
          if (vfs) {
            if (content === null) {
              try { vfs.unlinkSync(path); } catch {}
            } else {
              vfs.writeFileSync(path, content);
            }
          }
          break;

        case 'execute':
          if (!runtime) {
            parent.postMessage({ type: 'error', id, error: 'Runtime not initialized' }, '*');
            return;
          }
          const execResult = runtime.execute(code, filename);
          parent.postMessage({ type: 'result', id, result: execResult }, '*');
          break;

        case 'runFile':
          if (!runtime) {
            parent.postMessage({ type: 'error', id, error: 'Runtime not initialized' }, '*');
            return;
          }
          const runResult = runtime.runFile(filename);
          parent.postMessage({ type: 'result', id, result: runResult }, '*');
          break;

        case 'clearCache':
          if (runtime) {
            runtime.clearCache();
          }
          break;
      }
    } catch (error) {
      if (id) {
        parent.postMessage({
          type: 'error',
          id,
          error: error instanceof Error ? error.message : String(error),
        }, '*');
      }
    }
  });

  // Signal ready to parent
  parent.postMessage({ type: 'ready' }, '*');
</script>
</body>
</html>`;
}

/**
 * Get vercel.json configuration for the sandbox.
 * Sets up CORS headers to allow embedding as a cross-origin iframe.
 */
export function getSandboxVercelConfig(): object {
  return {
    headers: [
      {
        source: '/(.*)',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
    ],
  };
}

/**
 * Generate all files needed for deploying a sandbox to Vercel.
 *
 * @param justNodeUrl - URL to load just-node from
 * @returns Object with file names as keys and content as values
 *
 * @example
 * ```typescript
 * import { generateSandboxFiles } from 'just-node/sandbox-helpers';
 *
 * const files = generateSandboxFiles();
 * // Write files to sandbox/ directory
 * // Deploy to Vercel: cd sandbox && vercel --prod
 * ```
 */
export function generateSandboxFiles(justNodeUrl?: string): {
  'index.html': string;
  'vercel.json': string;
} {
  return {
    'index.html': getSandboxHtml(justNodeUrl),
    'vercel.json': JSON.stringify(getSandboxVercelConfig(), null, 2),
  };
}

/**
 * Instructions for setting up a sandbox on Vercel.
 * Useful for documentation or CLI output.
 */
export const SANDBOX_SETUP_INSTRUCTIONS = `
# Setting up a just-node Sandbox on Vercel

## 1. Create sandbox directory
   mkdir sandbox

## 2. Generate sandbox files
   Use generateSandboxFiles() or copy the templates manually.

## 3. Deploy to Vercel
   cd sandbox
   vercel --prod

## 4. Use in your app
   const runtime = await createRuntime(vfs, {
     sandbox: 'https://your-sandbox.vercel.app'
   });

For more details, see: https://github.com/anthropics/just-node#sandbox-setup
`.trim();
