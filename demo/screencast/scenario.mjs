/**
 * The scripted answers of the model: one list of steps for each user message.
 * A step is an object, or a function of the messages of the request.
 *
 * - `text`: the text of the answer.
 * - `calls`: its tool calls. pi runs them for real, in the page.
 * - `hold`: wait for the recording script before the end of the answer, so
 *   that the video can show a call before pi runs it.
 */

/**
 * The model id, as in contents/.pi/agent/models.json.
 */
export const MODEL = 'pi-demo';

const NOTEBOOK = 'sine.ipynb';

const CODE = `import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 2 * np.pi, 200)
plt.figure(figsize=(4.4, 2.6))
plt.plot(x, np.sin(x))
plt.title('sin(x)');`;

const README = `# Sine wave

\`sine.ipynb\` plots sin(x) from 0 to 2π
with NumPy and Matplotlib.
`;

const command = (commandId, args = {}) => ({
  name: 'execute_command',
  args: { commandId, args }
});

/**
 * A string value of the last tool result that has the key.
 */
function resultValue(messages, key) {
  const pattern = new RegExp(`"${key}":"([^"]+)"`);
  for (const message of [...messages].reverse()) {
    if (message.role !== 'tool') {
      continue;
    }
    const content =
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
    const match = content.replace(/\\"/g, '"').match(pattern);
    if (match) {
      return match[1];
    }
  }
}

export const scenario = [
  [
    {
      text: 'I look for the notebook commands, and for a command that splits the view.',
      calls: [
        {
          name: 'discover_commands',
          args: { query: 'jupyterlab-ai-commands' }
        },
        { name: 'discover_commands', args: { query: 'split tab' } }
      ]
    },
    {
      calls: [
        command('jupyterlab-ai-commands:create-notebook', { name: 'sine' })
      ]
    },
    {
      calls: [
        command('jupyterlab-ai-commands:open-file', { filePath: NOTEBOOK })
      ]
    },
    messages => ({
      hold: true,
      calls: [
        command('application:split-tab', {
          direction: 'right',
          id: resultValue(messages, 'widgetId')
        })
      ]
    }),
    {
      hold: true,
      calls: [
        command('jupyterlab-ai-commands:add-cell', {
          notebookPath: NOTEBOOK,
          cellType: 'code',
          content: CODE
        })
      ]
    },
    messages => ({
      calls: [
        command('jupyterlab-ai-commands:run-cell', {
          notebookPath: NOTEBOOK,
          cellId: resultValue(messages, 'cellId')
        })
      ]
    }),
    {
      text: '`sine.ipynb` is next to the terminal. It plots sin(x) from 0 to 2π.'
    }
  ],
  [
    {
      text: 'I write the file first.',
      calls: [
        { name: 'write', args: { path: '/drive/README.md', content: README } }
      ]
    },
    { calls: [{ name: 'discover_commands', args: { query: 'theme' } }] },
    {
      hold: true,
      calls: [command('apputils:change-theme', { theme: 'JupyterLab Dark' })]
    },
    {
      text: '`README.md` is in the file browser, and JupyterLab now uses the dark theme.'
    }
  ]
];
