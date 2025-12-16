// Incremental pattern matching orchestrator (plugin-driven)

import type { CompleteMatchResult, PartialMatchResult, PluginContext } from "@stream-mdx/plugins";
import { globalPluginRegistry } from "@stream-mdx/plugins";

/**
 * Manages incremental pattern matching for streaming content
 */
export class IncrementalMatcher {
  private activeMatches = new Map<string, ActiveMatch>();
  private completedMatches: CompleteMatchResult[] = [];

  /**
   * Process a new character in the stream
   */
  processCharacter(char: string, position: number, context: PluginContext): ProcessingResult {
    const results: ProcessingResult = {
      newMatches: [],
      completedMatches: [],
      abandonedMatches: [],
    };

    // Update all active matches
    this.updateActiveMatches(char, position, results);

    // Check for new potential matches starting at this position
    this.checkNewMatches(char, position, context, results);

    return results;
  }

  /**
   * Process a chunk of content at once
   */
  processChunk(content: string, startPosition: number, context: PluginContext): ProcessingResult {
    const results: ProcessingResult = {
      newMatches: [],
      completedMatches: [],
      abandonedMatches: [],
    };

    // Process character by character for accuracy
    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      const position = startPosition + i;
      const charResult = this.processCharacter(char, position, context);

      results.newMatches.push(...charResult.newMatches);
      results.completedMatches.push(...charResult.completedMatches);
      results.abandonedMatches.push(...charResult.abandonedMatches);
    }

    return results;
  }

  /**
   * Check for partial matches that might complete with more content
   */
  checkPartialMatches(content: string, context: PluginContext): PartialMatchResult[] {
    const results: PartialMatchResult[] = [];

    const plugins = globalPluginRegistry.getAllByPriority();

    for (const plugin of plugins) {
      try {
        const result = plugin.streamingHandler.checkPartialMatch(content);
        if (result.hasPartialMatch) {
          results.push(result);
        }
      } catch (error) {
        console.warn(`Plugin ${plugin.name} failed partial match check:`, error);
      }
    }

    return results;
  }

  /**
   * Force completion of all active matches
   */
  completeAllMatches(context: PluginContext): CompleteMatchResult[] {
    const results: CompleteMatchResult[] = [];

    for (const [matchId, activeMatch] of this.activeMatches) {
      try {
        const plugin = globalPluginRegistry.get(activeMatch.pluginName);
        if (plugin) {
          const result = plugin.streamingHandler.completeMatch(activeMatch.content);
          results.push(result);
        }
      } catch (error) {
        console.warn(`Failed to complete match ${matchId}:`, error);
      }
    }

    this.activeMatches.clear();
    return results;
  }

  /**
   * Get current active matches
   */
  getActiveMatches(): ActiveMatch[] {
    return Array.from(this.activeMatches.values());
  }

  /**
   * Clear all state
   */
  reset(): void {
    this.activeMatches.clear();
    this.completedMatches = [];
  }

  private updateActiveMatches(char: string, position: number, results: ProcessingResult): void {
    const toRemove: string[] = [];

    for (const [matchId, activeMatch] of this.activeMatches) {
      activeMatch.content += char;

      const plugin = globalPluginRegistry.get(activeMatch.pluginName);
      if (!plugin) {
        toRemove.push(matchId);
        continue;
      }

      try {
        // Check if this match is still viable
        const partialResult = plugin.streamingHandler.checkPartialMatch(activeMatch.content);

        if (!partialResult.hasPartialMatch) {
          // Match is no longer viable, try to complete it
          const completeResult = plugin.streamingHandler.completeMatch(activeMatch.content.slice(0, -1));

          if (completeResult.success) {
            results.completedMatches.push(completeResult);
          } else {
            results.abandonedMatches.push({
              matchId,
              pluginName: activeMatch.pluginName,
              content: activeMatch.content,
              reason: "Pattern no longer viable",
            });
          }

          toRemove.push(matchId);
        } else {
          // Update the match
          activeMatch.confidence = partialResult.confidence;
          activeMatch.lastUpdated = position;
        }
      } catch (error) {
        console.warn(`Error updating match ${matchId}:`, error);
        toRemove.push(matchId);
      }
    }

    // Remove completed or abandoned matches
    for (const matchId of toRemove) {
      this.activeMatches.delete(matchId);
    }
  }

  private checkNewMatches(char: string, position: number, context: PluginContext, results: ProcessingResult): void {
    const plugins = globalPluginRegistry.getAllByPriority();

    for (const plugin of plugins) {
      // Skip if we already have an active match for this plugin at this position
      const existingMatch = Array.from(this.activeMatches.values()).find((match) => match.pluginName === plugin.name && match.startPosition === position);

      if (existingMatch) continue;

      try {
        // Check if this character could start a new match
        const startPattern = plugin.patterns.start;
        if (startPattern.test(char)) {
          const matchId = `${plugin.name}-${position}-${Date.now()}`;

          const activeMatch: ActiveMatch = {
            matchId,
            pluginName: plugin.name,
            content: char,
            startPosition: position,
            confidence: 0.1, // Very low initial confidence
            lastUpdated: position,
          };

          this.activeMatches.set(matchId, activeMatch);
          results.newMatches.push(activeMatch);
        }
      } catch (error) {
        console.warn(`Error checking new match for plugin ${plugin.name}:`, error);
      }
    }
  }
}

/**
 * Active match being tracked
 */
interface ActiveMatch {
  matchId: string;
  pluginName: string;
  content: string;
  startPosition: number;
  confidence: number;
  lastUpdated: number;
}

/**
 * Abandoned match information
 */
interface AbandonedMatch {
  matchId: string;
  pluginName: string;
  content: string;
  reason: string;
}

/**
 * Result of processing characters
 */
interface ProcessingResult {
  newMatches: ActiveMatch[];
  completedMatches: CompleteMatchResult[];
  abandonedMatches: AbandonedMatch[];
}
