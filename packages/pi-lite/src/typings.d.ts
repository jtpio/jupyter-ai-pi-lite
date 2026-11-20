/**
 * The builder loads the SVG files that the code imports as strings.
 */
declare module '*.svg' {
  const value: string;
  export default value;
}

/**
 * The members that the Node shims of the build (`shims/`) add to the modules
 * of Node.
 */
declare module 'fs' {
  /**
   * The in-memory volume of the module.
   */
  const vol: import('memfs').Volume;

  /**
   * Reads the JupyterLab files, which are not in memory. The host sets it.
   */
  let drive:
    | {
        access(absolutePath: string): Promise<void>;
        readFile(absolutePath: string): Promise<Buffer>;
      }
    | undefined;

  /**
   * Lists a directory of the JupyterLab files for `readdirSync`, while the
   * path completion sets it.
   */
  let listDrive: ((directory: string) => object[]) | undefined;

  /**
   * Called with each path that changes.
   */
  let onChange: ((changed: string) => void) | undefined;
}

declare module 'child_process' {
  /**
   * The commands that `spawn` runs in the page: they resolve with the
   * standard output.
   */
  const commands: Map<
    string,
    (args: string[], signal: AbortSignal) => Promise<string>
  >;
}

declare namespace NodeJS {
  interface Process {
    /**
     * The error that `process.exit` throws.
     */
    ProcessExit: new (code: number) => Error & { code: number };
  }
}

/**
 * pi modules that the package exports map hides; the build aliases
 * `pi-coding-agent-package` to the package folder.
 */
declare module 'pi-coding-agent-package/dist/core/model-resolver.js' {
  import type {
    Api,
    Model,
    ModelThinkingLevel as ThinkingLevel
  } from '@earendil-works/pi-ai';
  import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

  export function findInitialModel(options: {
    scopedModels: [];
    isContinuing: boolean;
    defaultProvider?: string;
    defaultModelId?: string;
    defaultThinkingLevel?: ThinkingLevel;
    modelThinkingLevels?: Record<string, ThinkingLevel>;
    modelRuntime: ModelRuntime;
  }): Promise<{ model: Model<Api> | undefined; thinkingLevel: ThinkingLevel }>;
}

declare module 'pi-coding-agent-package/dist/core/auth-storage.js' {
  import type { CredentialStore } from '@earendil-works/pi-ai';

  export const AuthStorage: {
    create(authPath?: string): CredentialStore;
  };
}

declare module 'pi-coding-agent-package/dist/core/project-trust.js' {
  import type {
    DefaultProjectTrust,
    ProjectTrustContext,
    ProjectTrustStore
  } from '@earendil-works/pi-coding-agent';

  export function resolveProjectTrusted(options: {
    cwd: string;
    trustStore: ProjectTrustStore;
    trustOverride?: boolean;
    defaultProjectTrust?: DefaultProjectTrust;
    projectTrustContext: ProjectTrustContext;
  }): Promise<boolean>;
}

declare module 'pi-coding-agent-package/dist/core/settings-diagnostics.js' {
  import type { SettingsManager } from '@earendil-works/pi-coding-agent';

  export function collectSettingsDiagnostics(
    settingsManager: SettingsManager
  ): { type: 'warning'; message: string }[];
}

declare module 'pi-coding-agent-package/dist/core/slash-commands.js' {
  export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<{
    name: string;
    description: string;
  }>;
}

declare module 'pi-coding-agent-package/dist/core/tools/path-utils.js' {
  export function resolveToCwd(filePath: string, cwd: string): string;
}

declare module 'pi-coding-agent-package/dist/core/settings-manager.js' {
  export function isToolModifier(entry: unknown): entry is string;
  export function applyToolModifiers(
    base: string[],
    entries: string[]
  ): string[];
}

declare module 'pi-coding-agent-package/dist/utils/json.js' {
  export function stripJsonComments(input: string): string;
}
