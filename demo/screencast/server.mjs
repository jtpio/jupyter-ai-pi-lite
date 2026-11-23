/**
 * Serve the JupyterLite site and a scripted OpenAI-compatible model on one
 * origin, so that a recording is the same on each run.
 *
 * Usage: node server.mjs <site directory> [port]
 *
 * The recording script sets the pace: each answer waits for a ticket before
 * its first token, and a step with `hold` waits for one more before its end
 * (pi runs the tool calls of an answer when the answer ends).
 * POST /gate adds a ticket, POST /gate/reset removes them all.
 *
 * The delays between the tokens are `: wait <ms>` comments in the stream. The
 * recording script makes the page wait on its own clock, which a frame-perfect
 * recording slows down. Another client ignores the comments.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { MODEL, scenario } from './scenario.mjs';

const [site, port = '8765'] = process.argv.slice(2);
/**
 * GATES=0 lets the answers run without tickets, to try the site by hand.
 */
const GATES = process.env.GATES !== '0';

const TYPES = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.ipynb': 'application/json',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.md': 'text/markdown',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.whl': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

let tickets = 0;
let waiting = [];

/**
 * Wait for a ticket of the recording script.
 */
function ticket() {
  if (!GATES) {
    return Promise.resolve();
  }
  if (tickets > 0) {
    tickets--;
    return Promise.resolve();
  }
  return new Promise(resolve => waiting.push(resolve));
}

function addTicket() {
  const resolve = waiting.shift();
  if (resolve) {
    resolve();
  } else {
    tickets++;
  }
}

/**
 * The answer of the scenario for a request: the turn is the number of user
 * messages, the step the number of assistant messages after the last one.
 */
function nextStep(messages) {
  const users = messages.filter(message => message.role === 'user').length;
  const last = messages.map(message => message.role).lastIndexOf('user');
  const step = messages
    .slice(last + 1)
    .filter(message => message.role === 'assistant').length;
  const answer = scenario[users - 1]?.[step] ?? { text: 'Done.' };
  return typeof answer === 'function' ? answer(messages) : answer;
}

/**
 * Split a text in small parts, as a model streams its tokens.
 */
function tokens(text, size) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }
  return parts;
}

async function complete(request, response) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  const { messages = [] } = JSON.parse(body);
  const step = nextStep(messages);
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = fields =>
    response.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MODEL, ...fields })}\n\n`
    );
  const send = (delta, finish = null) =>
    chunk({ choices: [{ index: 0, delta, finish_reason: finish }] });

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const wait = ms => response.write(`: wait ${ms}\n\n`);
  await ticket();
  wait(220);
  send({ role: 'assistant', content: '' });
  for (const token of tokens(step.text ?? '', 5)) {
    send({ content: token });
    wait(30);
  }
  const calls = step.calls ?? [];
  for (const [index, call] of calls.entries()) {
    wait(110);
    send({
      tool_calls: [
        {
          index,
          id: `call_${created}_${index}`,
          type: 'function',
          function: { name: call.name, arguments: '' }
        }
      ]
    });
    for (const token of tokens(JSON.stringify(call.args), 14)) {
      send({ tool_calls: [{ index, function: { arguments: token } }] });
      wait(14);
    }
  }
  if (step.hold) {
    await ticket();
  }
  send({}, calls.length ? 'tool_calls' : 'stop');
  chunk({
    choices: [],
    usage: { prompt_tokens: 2400, completion_tokens: 120, total_tokens: 2520 }
  });
  response.end('data: [DONE]\n\n');
}

function serveFile(url, response) {
  let file = normalize(join(site, decodeURIComponent(url.pathname)));
  if (!file.startsWith(normalize(site))) {
    response.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) {
    file = join(file, 'index.html');
  }
  if (!existsSync(file)) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  createReadStream(file).pipe(response);
}

createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const post = request.method === 'POST';
  if (post && url.pathname === '/v1/chat/completions') {
    complete(request, response).catch(error => {
      console.error(error);
      response.end();
    });
  } else if (post && url.pathname === '/gate') {
    addTicket();
    response.writeHead(204).end();
  } else if (post && url.pathname === '/gate/reset') {
    tickets = 0;
    waiting = [];
    response.writeHead(204).end();
  } else {
    serveFile(url, response);
  }
}).listen(Number(port), '127.0.0.1', () => {
  console.log(`http://localhost:${port}/lab/index.html`);
});
