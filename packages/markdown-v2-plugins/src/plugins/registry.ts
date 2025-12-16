// Plugin registration and management system

import {
  type CompleteMatchResult,
  ConflictResolution,
  type MarkdownPlugin,
  type PluginContext,
  PluginError,
  PluginException,
  type PluginRegistrationResult,
} from "./base";

/**
 * Central registry for managing markdown plugins
 */
export class PluginRegistry {
  private plugins = new Map<string, MarkdownPlugin>();
  private pluginsByPriority: MarkdownPlugin[] = [];
  private conflictResolution = ConflictResolution.PRIORITY;

  /**
   * Register a new plugin
   */
  register(plugin: MarkdownPlugin): PluginRegistrationResult {
    try {
      // Validate plugin
      this.validatePlugin(plugin);

      // Check for conflicts
      const conflicts = this.findConflicts(plugin);

      // Register plugin
      this.plugins.set(plugin.name, plugin);
      this.rebuildPriorityList();

      return {
        success: true,
        message: `Plugin '${plugin.name}' registered successfully`,
        conflicts,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Unregister a plugin
   */
  unregister(pluginName: string): boolean {
    const removed = this.plugins.delete(pluginName);
    if (removed) {
      this.rebuildPriorityList();
    }
    return removed;
  }

  /**
   * Get a plugin by name
   */
  get(pluginName: string): MarkdownPlugin | undefined {
    return this.plugins.get(pluginName);
  }

  /**
   * Get all plugins ordered by priority
   */
  getAllByPriority(): MarkdownPlugin[] {
    return [...this.pluginsByPriority];
  }

  /**
   * Get all plugins
   */
  getAll(): MarkdownPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Find plugins that can handle specific content
   */
  findMatchingPlugins(content: string, context: PluginContext): MarkdownPlugin[] {
    const matching: MarkdownPlugin[] = [];

    for (const plugin of this.pluginsByPriority) {
      try {
        const result = plugin.streamingHandler.checkPartialMatch(content);
        if (result.hasPartialMatch || this.testFullPattern(plugin, content)) {
          matching.push(plugin);
        }
      } catch (error) {
        console.warn(`Plugin ${plugin.name} failed pattern check:`, error);
      }
    }

    return matching;
  }

  /**
   * Resolve conflicts between multiple matching plugins
   */
  resolveConflicts(plugins: MarkdownPlugin[], content: string, context: PluginContext): MarkdownPlugin | null {
    if (plugins.length === 0) return null;
    if (plugins.length === 1) return plugins[0];

    switch (this.conflictResolution) {
      case ConflictResolution.PRIORITY:
        return this.resolveByPriority(plugins);

      case ConflictResolution.LONGEST_MATCH:
        return this.resolveByLongestMatch(plugins, content);

      case ConflictResolution.CONFIDENCE:
        return this.resolveByConfidence(plugins, content);

      case ConflictResolution.FIRST_REGISTERED:
        return plugins[0];

      default:
        return plugins[0];
    }
  }

  /**
   * Process content with the best matching plugin
   */
  async processContent(content: string, context: PluginContext): Promise<CompleteMatchResult | null> {
    const matchingPlugins = this.findMatchingPlugins(content, context);
    const selectedPlugin = this.resolveConflicts(matchingPlugins, content, context);

    if (!selectedPlugin) return null;

    try {
      return selectedPlugin.streamingHandler.completeMatch(content);
    } catch (error) {
      throw new PluginException(PluginError.TOKENIZATION_FAILED, error instanceof Error ? error.message : String(error), selectedPlugin.name, context);
    }
  }

  /**
   * Set conflict resolution strategy
   */
  setConflictResolution(strategy: ConflictResolution): void {
    this.conflictResolution = strategy;
  }

  /**
   * Validate plugin before registration
   */
  private validatePlugin(plugin: MarkdownPlugin): void {
    if (!plugin.name || typeof plugin.name !== "string") {
      throw new Error("Plugin must have a valid name");
    }

    if (typeof plugin.priority !== "number") {
      throw new Error("Plugin must have a numeric priority");
    }

    if (!plugin.patterns) {
      throw new Error("Plugin must define patterns");
    }

    if (!plugin.tokenizer) {
      throw new Error("Plugin must provide a tokenizer");
    }

    if (!plugin.streamingHandler) {
      throw new Error("Plugin must provide a streaming handler");
    }

    // Validate patterns
    this.validatePatterns(plugin);
  }

  /**
   * Validate plugin patterns
   */
  private validatePatterns(plugin: MarkdownPlugin): void {
    const { patterns } = plugin;

    if (!(patterns.start instanceof RegExp)) {
      throw new Error("Plugin start pattern must be a RegExp");
    }

    if (!(patterns.end instanceof RegExp)) {
      throw new Error("Plugin end pattern must be a RegExp");
    }

    if (!(patterns.full instanceof RegExp)) {
      throw new Error("Plugin full pattern must be a RegExp");
    }

    // Test patterns with sample input
    try {
      patterns.start.test("test");
      patterns.end.test("test");
      patterns.full.test("test");
    } catch (error) {
      throw new Error(`Invalid regex patterns in plugin: ${error}`);
    }
  }

  /**
   * Find potential conflicts with existing plugins
   */
  private findConflicts(newPlugin: MarkdownPlugin): string[] {
    const conflicts: string[] = [];

    for (const [name, existingPlugin] of this.plugins) {
      // Check for pattern overlaps
      if (this.patternsOverlap(newPlugin, existingPlugin)) {
        conflicts.push(name);
      }

      // Check for priority conflicts
      if (newPlugin.priority === existingPlugin.priority) {
        conflicts.push(`${name} (same priority: ${newPlugin.priority})`);
      }
    }

    return conflicts;
  }

  /**
   * Check if two plugins have overlapping patterns
   */
  private patternsOverlap(plugin1: MarkdownPlugin, plugin2: MarkdownPlugin): boolean {
    const testStrings = [
      "$math$", // inline math
      "$$display$$", // display math
      "<Component />", // MDX component
      "{expression}", // MDX expression
      "<!-- comment -->", // HTML comment
      "<div>content</div>", // HTML tag
    ];

    for (const testString of testStrings) {
      const matches1 = this.testAllPatterns(plugin1, testString);
      const matches2 = this.testAllPatterns(plugin2, testString);

      if (matches1 && matches2) {
        return true; // Both plugins match the same test string
      }
    }

    return false;
  }

  /**
   * Test all patterns of a plugin against content
   */
  private testAllPatterns(plugin: MarkdownPlugin, content: string): boolean {
    try {
      return plugin.patterns.full.test(content) || (plugin.patterns.start.test(content) && plugin.patterns.end.test(content));
    } catch {
      return false;
    }
  }

  /**
   * Test full pattern match
   */
  private testFullPattern(plugin: MarkdownPlugin, content: string): boolean {
    try {
      return plugin.patterns.full.test(content);
    } catch {
      return false;
    }
  }

  /**
   * Rebuild priority-ordered list
   */
  private rebuildPriorityList(): void {
    this.pluginsByPriority = Array.from(this.plugins.values()).sort((a, b) => b.priority - a.priority); // Higher priority first
  }

  /**
   * Resolve conflicts by priority
   */
  private resolveByPriority(plugins: MarkdownPlugin[]): MarkdownPlugin {
    return plugins.reduce((highest, current) => (current.priority > highest.priority ? current : highest));
  }

  /**
   * Resolve conflicts by longest match
   */
  private resolveByLongestMatch(plugins: MarkdownPlugin[], content: string): MarkdownPlugin {
    let longestMatch: MarkdownPlugin | null = null;
    let longestLength = 0;

    for (const plugin of plugins) {
      try {
        const match = content.match(plugin.patterns.full);
        if (match && match[0].length > longestLength) {
          longestLength = match[0].length;
          longestMatch = plugin;
        }
      } catch {}
    }

    return longestMatch || plugins[0];
  }

  /**
   * Resolve conflicts by confidence
   */
  private resolveByConfidence(plugins: MarkdownPlugin[], content: string): MarkdownPlugin {
    let bestPlugin: MarkdownPlugin | null = null;
    let bestConfidence = 0;

    for (const plugin of plugins) {
      try {
        const result = plugin.streamingHandler.checkPartialMatch(content);
        if (result.confidence > bestConfidence) {
          bestConfidence = result.confidence;
          bestPlugin = plugin;
        }
      } catch {}
    }

    return bestPlugin || plugins[0];
  }

  /**
   * Get registry statistics
   */
  getStats(): RegistryStats {
    const pluginsByType: Record<string, number> = {};
    const priorityDistribution: Record<number, number> = {};

    for (const plugin of this.plugins.values()) {
      // Count by type (inferred from name)
      const type = plugin.name.split("-")[0];
      pluginsByType[type] = (pluginsByType[type] || 0) + 1;

      // Count by priority
      priorityDistribution[plugin.priority] = (priorityDistribution[plugin.priority] || 0) + 1;
    }

    return {
      totalPlugins: this.plugins.size,
      pluginsByType,
      priorityDistribution,
      conflictResolution: this.conflictResolution,
    };
  }
}

/**
 * Registry statistics
 */
export interface RegistryStats {
  totalPlugins: number;
  pluginsByType: Record<string, number>;
  priorityDistribution: Record<number, number>;
  conflictResolution: ConflictResolution;
}

// Global plugin registry instance
export const globalPluginRegistry = new PluginRegistry();
