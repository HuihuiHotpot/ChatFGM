import {
  loadToolboxDefinition,
  readToolboxAgents,
  ToolboxError,
  type LoadedToolbox,
  type ToolboxDefinition,
} from './registry';

export type ToolboxDefinitionReader = (
  appPath: string,
  name: string,
) => ToolboxDefinition;

export interface ToolboxCatalogOptions {
  /** Read seam; production reads the named toolbox from disk. */
  read?: ToolboxDefinitionReader;
}

/**
 * Backend-process cache of successfully loaded toolbox resources.
 *
 * A toolbox is read from disk at most once per application run. Projects and
 * conversations that bind the same toolbox folder share the cached directory,
 * AGENTS.md text, skill metadata and tools path. Failures are never cached:
 * the next attempt reports the current on-disk problem again instead of
 * leaving a partial identity. Resource changes are intentionally picked up
 * only after the application restarts.
 */
export class ToolboxCatalog {
  private readonly appPath: string;
  private readonly read: ToolboxDefinitionReader;
  private readonly loaded = new Map<string, LoadedToolbox>();

  constructor(appPath: string, options: ToolboxCatalogOptions = {}) {
    this.appPath = appPath;
    this.read = options.read ?? loadToolboxDefinition;
  }

  /** Number of distinct toolboxes held by this process cache. */
  get size(): number {
    return new Set(this.loaded.values()).size;
  }

  load(name: string): LoadedToolbox {
    if (typeof name !== 'string' || !name) {
      throw new ToolboxError('toolbox-missing', `工具箱「${String(name)}」不存在。`);
    }
    const cached = this.findCached(name);
    if (cached) return cached;

    let definition: ToolboxDefinition;
    try {
      definition = this.read(this.appPath, name);
    } catch (error) {
      if (error instanceof ToolboxError) throw error;
      throw new ToolboxError(
        'toolbox-load-failed',
        `无法读取工具箱「${name}」。`,
        { cause: error },
      );
    }
    if (definition.error) {
      throw new ToolboxError('toolbox-invalid', definition.error);
    }
    const existing = this.loaded.get(definition.name);
    if (existing) {
      this.remember(name, existing);
      return existing;
    }

    // AGENTS.md is read before the cache entry is created, so a failed read
    // cannot leave a half-loaded toolbox behind. A missing AGENTS.md is a
    // supported state and is cached as null.
    const loaded: LoadedToolbox = Object.freeze({
      ...definition,
      agentsText: readToolboxAgents(definition),
    });
    this.remember(definition.name, loaded);
    this.remember(name, loaded);
    return loaded;
  }

  get(name: string): LoadedToolbox | undefined {
    return this.findCached(name);
  }

  has(name: string): boolean {
    return this.findCached(name) !== undefined;
  }

  clear(): void {
    this.loaded.clear();
  }

  private remember(name: string, toolbox: LoadedToolbox): void {
    this.loaded.set(name, toolbox);
  }

  private findCached(name: string): LoadedToolbox | undefined {
    const exact = this.loaded.get(name);
    if (exact) return exact;
    const folded = name.toLocaleLowerCase('en-US');
    for (const [key, toolbox] of this.loaded) {
      if (key.toLocaleLowerCase('en-US') === folded) return toolbox;
    }
    return undefined;
  }
}
