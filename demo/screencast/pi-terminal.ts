/**
 * Screencast: the pi coding agent in the JupyterLite terminal.
 *
 * The model is scripted (see scenario.mjs); pi runs its tool calls for real.
 *
 *   npm install
 *   npm run build     # the JupyterLite site, in dist
 *   npm run serve     # the site and the scripted model, on port 8765
 *   npm run record    # pi-terminal.mp4
 *
 * To try a change, record in real time:
 *   npx autokast record pi-terminal.ts --set capture.mode=realtime --set deviceScaleFactor=2
 */
import { defineScreencast, type Cast } from 'autokast';
import type { Page } from 'playwright';

import { MODEL } from './scenario.mjs';

const ORIGIN = 'http://localhost:8765';

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Camera framings, in viewport pixels: the shell prompt, then the main area
 * without the menu and the sidebar (the terminal alone, then the terminal
 * and the notebook).
 */
const PROMPT: Rect = { x: 285, y: 30, width: 753, height: 424 };
const TERMINAL: Rect = { x: 272, y: 76, width: 1008, height: 567 };
const MAIN: Rect = { x: 272, y: 105, width: 1008, height: 567 };

/**
 * Let the scripted model send its next answer, or end an answer on hold.
 */
async function next(): Promise<void> {
  await fetch(`${ORIGIN}/gate`, { method: 'POST' });
}

/**
 * Page script: make the stream of the scripted model wait on the page clock,
 * at its `: wait <ms>` comments. A frame-perfect recording slows that clock.
 */
function paceModelStream(): void {
  const fetchPage = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await fetchPage(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('/v1/chat/completions') || !response.body) {
      return response;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end < 0) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            continue;
          }
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const wait = /^: wait (\d+)$/.exec(event);
          if (!wait) {
            controller.enqueue(encoder.encode(`${event}\n\n`));
            return;
          }
          await new Promise(resolve => setTimeout(resolve, Number(wait[1])));
        }
      },
      cancel: reason => reader.cancel(reason)
    });
    return new Response(body, {
      status: response.status,
      headers: response.headers
    });
  };
}

interface ITerminalView {
  lines: string[];
  left: number;
  top: number;
  width: number;
  rowHeight: number;
}

/**
 * The visible text of the terminal and the place of its rows in the page.
 * xterm.js draws on a canvas: the page has no text to locate.
 */
function terminalView(page: Page): Promise<ITerminalView> {
  return page.evaluate(() => {
    const app = (window as any).jupyterapp;
    const widget = [...app.shell.widgets('main')].find((item: any) =>
      item.content?.node.classList.contains('jp-Terminal')
    ) as any;
    const term = widget?.content._term;
    if (!term?.element) {
      return { lines: [], left: 0, top: 0, width: 0, rowHeight: 0 };
    }
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      lines.push(line ? line.translateToString(true) : '');
    }
    const screen = term.element
      .querySelector('.xterm-screen')
      .getBoundingClientRect();
    return {
      lines,
      left: screen.left,
      top: screen.top,
      width: screen.width,
      rowHeight: screen.height / term.rows
    };
  });
}

/**
 * Wait until the terminal shows a text, on one row.
 */
async function shows(page: Page, text: string, timeout = 180_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const view = await terminalView(page);
    if (view.lines.some(line => line.includes(text))) {
      return;
    }
    if (Date.now() > end) {
      throw new Error(
        `The terminal does not show "${text}":\n${view.lines.join('\n')}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

interface IRows {
  /**
   * Number of rows. Default: 1.
   */
  rows?: number;
  /**
   * Text of the last row, in place of `rows`.
   */
  to?: string;
}

/**
 * The rectangle of terminal rows, from the last row with `from`.
 */
async function rowsOf(page: Page, from: string, options: IRows = {}) {
  const view = await terminalView(page);
  const first = view.lines.findLastIndex(line => line.includes(from));
  if (first < 0) {
    return undefined;
  }
  let rows = options.rows ?? 1;
  if (options.to) {
    const last = view.lines.findIndex(
      (line, index) => index >= first && line.includes(options.to!)
    );
    rows = last < 0 ? rows : last - first + 1;
  }
  return {
    x: view.left,
    y: view.top + first * view.rowHeight,
    width: view.width,
    height: rows * view.rowHeight
  };
}

/**
 * The rectangle of terminal rows once they stay in place: pi draws an answer
 * in several steps.
 */
async function settledRows(cast: Cast, from: string, options: IRows = {}) {
  await shows(cast.page, from);
  let last: Rect | undefined;
  for (;;) {
    await cast.wait(90);
    const rect = await rowsOf(cast.page, from, options);
    if (rect && last && rect.y === last.y && rect.height === last.height) {
      return rect;
    }
    last = rect;
  }
}

/**
 * Keep the idle cursor hidden across a cut. The renderer draws a line from
 * the end of a cursor move to the first step of the next one: a cut in
 * between makes the cursor jump a little, and so show again. A sample at the
 * place of the cursor, after the cut, keeps that line flat.
 */
async function holdCursor(cast: Cast): Promise<void> {
  const { x, y } = (cast as unknown as { position: Rect }).position;
  await cast.moveTo({ x: x + 0.01, y });
}

export default defineScreencast({
  name: 'pi-terminal',
  url: `${ORIGIN}/lab/index.html?reset`,
  viewport: { width: 1280, height: 720 },
  // The close shots need 3 device pixels per CSS pixel to stay sharp.
  deviceScaleFactor: 3,
  capture: { mode: 'frame-perfect' },
  typing: { delay: 34 },
  // Pyodide comes from a CDN.
  browser: process.env.HTTPS_PROXY
    ? {
        proxy: {
          server: process.env.HTTPS_PROXY,
          bypass: 'localhost,127.0.0.1'
        }
      }
    : {},
  render: {
    preset: 'focus',
    cursor: { hideAfter: 1500 },
    // About half the size of the standard quality: GitHub accepts 10 MB.
    encode: { crf: 23 }
  },

  async setup({ page }) {
    await fetch(`${ORIGIN}/gate/reset`, { method: 'POST' });
    await page.addInitScript(paceModelStream);
    await page.reload();
    await page.locator('.jp-Launcher').waitFor({ timeout: 120_000 });
    await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
  },

  async run(cast) {
    const { page } = cast;

    // Open a terminal and start pi.
    await cast.click(
      page.locator('.jp-LauncherCard', { hasText: 'Terminal' }),
      {
        afterClick: 0
      }
    );
    await cast.cut(() => shows(page, 'js-shell:'));
    await cast.wait(350);
    await cast.zoomTo(PROMPT, { scale: 1.7, follow: 'off', wait: true });
    await cast.type('pi', { delay: 110 });
    await cast.press('Enter');
    await cast.cut(() => shows(page, MODEL));
    await holdCursor(cast);
    await cast.wait(900);

    // First request: a notebook next to the terminal.
    await cast.zoomTo(TERMINAL, { scale: 1.27, follow: 'off' });
    await cast.type(
      'Plot a sine wave in a new notebook, next to this terminal'
    );
    await cast.press('Enter');
    await next();
    await shows(page, '"commandCount": 1,');
    await cast.spotlight(
      await settledRows(cast, 'query="jupyterlab-ai-commands"'),
      { duration: 1300, wait: true }
    );
    await next();
    await shows(page, 'Successfully created notebook');
    await cast.wait(550);
    await next();
    await shows(page, '"widgetId"');
    await cast.wait(450);

    // pi splits the view: show the call, then the result on the full page.
    await next();
    await shows(page, '"direction":"right"');
    await cast.spotlight(
      await settledRows(cast, 'application:split-tab" args'),
      { duration: 1300, wait: true }
    );
    await cast.zoomOut({ wait: true });
    await next();
    await page.locator('.jp-NotebookPanel').waitFor();
    await shows(page, 'Command executed successfully');
    await cast.wait(900);

    // The cell and its output, with the terminal in the same shot.
    await cast.zoomTo(MAIN, { scale: 1.27, follow: 'off' });
    await next();
    await shows(page, 'commands:add-cell"');
    await cast.wait(300);
    await next();
    await shows(page, 'code cell added successfully');
    await cast.wait(700);
    await next();
    const approval = await settledRows(cast, 'Allow execute_command', {
      to: ' No'
    });
    await cast.zoomTo(approval, { scale: 1.7, follow: 'off' });
    await cast.spotlight(approval, { duration: 1300, wait: true, padding: 8 });
    await cast.wait(250);
    await cast.press('Enter');
    await cast.zoomTo(MAIN, { scale: 1.27, follow: 'off', wait: true });
    await cast.cut(() =>
      page.locator('.jp-OutputArea-output img').waitFor({ timeout: 180_000 })
    );
    await holdCursor(cast);
    await cast.wait(1200);
    await next();
    await shows(page, 'It plots');
    await cast.wait(1000);

    // Second request: a file, then the theme.
    const view = await terminalView(page);
    const input: Rect = {
      x: view.left,
      y: 420,
      width: view.width,
      height: 270
    };
    await cast.zoomTo(input, { scale: 1.6, follow: 'off' });
    await cast.type('Add a README.md, then switch to the dark theme');
    await cast.press('Enter');
    await next();
    await cast.spotlight(
      await settledRows(cast, 'Allow write', { to: ' No' }),
      { duration: 1300, wait: true, padding: 8 }
    );
    await cast.wait(250);
    await cast.press('Enter');
    const readme = page.locator('.jp-DirListing-item', {
      hasText: 'README.md'
    });
    await cast.cut(() => readme.waitFor());
    await holdCursor(cast);
    await cast.zoomTo(readme, { scale: 1.7, follow: 'off' });
    await cast.hover(readme, { position: { x: 0.56, y: 0.8 }, hold: 150 });
    await cast.spotlight(readme, { duration: 1300, wait: true, padding: 4 });

    // Back to the terminal, with the cursor: no file stays highlighted.
    await cast.zoomTo(input, { scale: 1.6, follow: 'off' });
    await cast.moveTo({ x: view.left + view.width * 0.72, y: 560 });
    await next();
    await shows(page, '"commandCount": 7,');
    await cast.wait(300);
    await next();
    await shows(page, 'JupyterLab Dark');
    await cast.spotlight(
      await settledRows(cast, 'apputils:change-theme"', { rows: 2 }),
      { duration: 1300, wait: true }
    );
    await cast.zoomOut({ wait: true });
    // The theme change shows the splash screen, then pi draws its colors again.
    await cast.cut(async () => {
      await next();
      await page
        .locator('body[data-jp-theme-light="false"]')
        .waitFor({ state: 'attached' });
      await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
      await shows(page, 'Command executed successfully');
      await page.waitForTimeout(1500);
    });
    await holdCursor(cast);
    await cast.wait(1200);
    await next();
    await shows(page, 'JupyterLab now');
    await cast.wait(1400);
  }
});
