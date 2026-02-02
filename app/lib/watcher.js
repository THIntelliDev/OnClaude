const { parseOptions } = require('./option-parser');
const stripAnsiModule = require('strip-ansi');

/**
 * Watches PTY output for input prompts and triggers notifications
 */
class Watcher {
  constructor(options = {}) {
    this.maxLines = options.maxLines || 50;
    this.lines = [];
    this.lastTrigger = null;
    this.lastTriggerTime = 0;
    this.onTrigger = options.onTrigger || (() => {});
  }

  /**
   * Strip ANSI escape codes from text using safe strip-ansi module
   * @param {string} text
   * @returns {string}
   */
  stripAnsi(text) {
    // Limit input length to prevent DoS
    if (text.length > 100000) {
      text = text.slice(-100000);
    }
    return stripAnsiModule(text);
  }

  /**
   * Process a chunk of PTY output
   * @param {string} data - Raw PTY output (may contain ANSI codes)
   * @returns {object|null} - Trigger result if prompt detected, null otherwise
   */
  process(data) {
    // Strip ANSI for pattern matching
    const stripped = this.stripAnsi(data);

    // Add new content to line buffer
    const newLines = stripped.split('\n');
    for (const line of newLines) {
      if (line.trim().length > 0) {
        this.lines.push(line);
      }
    }

    // Keep only last N lines
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(-this.maxLines);
    }

    // Check for triggers
    const windowText = this.lines.join('\n');
    const result = parseOptions(windowText);

    if (result) {
      const triggerHash = this._hashPrompt(result.prompt);

      // Check if this is a new trigger
      if (triggerHash !== this.lastTrigger) {
        this.lastTrigger = triggerHash;
        this.lastTriggerTime = Date.now();

        // Call the trigger callback
        this.onTrigger(result);

        return {
          type: 'options',
          prompt: result.prompt,
          options: result.options,
          patternName: result.patternName,
          isNew: true,
        };
      }
    }

    return null;
  }

  /**
   * Get the current rolling buffer content
   * @returns {string}
   */
  getBuffer() {
    return this.lines.join('\n');
  }

  /**
   * Get the last detected trigger info
   * @returns {object|null}
   */
  getLastTrigger() {
    if (!this.lastTrigger) return null;

    const windowText = this.lines.join('\n');
    const result = parseOptions(windowText);

    if (result) {
      return {
        type: 'options',
        prompt: result.prompt,
        options: result.options,
        patternName: result.patternName,
        detectedAt: this.lastTriggerTime,
      };
    }

    return null;
  }

  /**
   * Reset the watcher state
   */
  reset() {
    this.lines = [];
    this.lastTrigger = null;
    this.lastTriggerTime = 0;
  }

  /**
   * Hash a prompt string for comparison
   * @private
   */
  _hashPrompt(prompt) {
    // Simple hash for comparison
    let hash = 0;
    for (let i = 0; i < prompt.length; i++) {
      const char = prompt.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }
}

/**
 * Trigger patterns for quick detection (before full parsing)
 * These are used for quick checks without full option extraction
 */
const TRIGGER_PATTERNS = [
  /do you want to proceed/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\(yes\/no\)/i,
  /allow .* tool call/i,
  /approve|reject/i,
  /select an option/i,
  /continue\?/i,
  /proceed\?/i,
  /press enter/i,
  /waiting for (?:your )?input/i,
  /would you like to/i,
  /^\s*\d+\.\s+\w/m,
  /\([a-z]\)[a-z]+.*\([a-z]\)[a-z]+/i,
  /Enter to (?:confirm|select).*Esc to cancel/i, // Claude's menu confirmation prompt
  /❯\s*\d+\./m, // Claude's menu with selection arrow
];

/**
 * Quick check if text might contain a trigger
 * @param {string} text
 * @returns {boolean}
 */
function mightContainTrigger(text) {
  // Limit input to prevent DoS
  const limited = text.length > 50000 ? text.slice(-50000) : text;
  // Use strip-ansi module for safe ANSI removal
  const stripped = stripAnsiModule(limited);
  return TRIGGER_PATTERNS.some((pattern) => pattern.test(stripped));
}

module.exports = {
  Watcher,
  mightContainTrigger,
  TRIGGER_PATTERNS,
};
