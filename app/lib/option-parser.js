/**
 * Parses Claude Code prompts and extracts structured options for the UI
 */

/**
 * Pattern definitions for option extraction
 */
const OPTION_PATTERNS = [
  // Pattern: (y/n) or [y/n] or [Y/n] or [y/N]
  {
    name: 'yes-no',
    regex: /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]/i,
    extract: () => [
      { label: 'Yes', value: 'y' },
      { label: 'No', value: 'n' },
    ],
    priority: 10,
  },

  // Pattern: (y/n/a) or (y/n/always)
  {
    name: 'yes-no-always',
    regex: /\(y\/n\/a(?:lways)?\)/i,
    extract: () => [
      { label: 'Yes', value: 'y' },
      { label: 'No', value: 'n' },
      { label: 'Always', value: 'a' },
    ],
    priority: 11,
  },

  // Pattern: Numbered options - simple approach
  // Looks for any line containing "1." through "9."
  {
    name: 'numbered-options',
    regex: /\d+\.\s+[A-Z]/,
    extract: (match, text) => {
      const found = new Map();

      // Split into lines and look for numbered items
      const lines = text.split('\n');
      for (const line of lines) {
        // Simple pattern: find "N. " followed by a capital letter anywhere in line
        const match = line.match(/(\d+)\.\s+([A-Z])/);
        if (match) {
          const num = match[1];
          if (!found.has(num) && parseInt(num) >= 1 && parseInt(num) <= 20) {
            found.set(num, true);
          }
        }
      }

      // Convert to sorted array
      const options = Array.from(found.keys())
        .sort((a, b) => parseInt(a) - parseInt(b))
        .map(num => ({ label: num, value: num }));

      return options.length >= 2 ? options : null;
    },
    priority: 15,
  },

  // Pattern: Press Enter to continue
  {
    name: 'press-enter',
    regex: /press\s+enter|Enter to (?:confirm|select)/i,
    extract: () => [{ label: 'OK', value: '' }],
    priority: 9,
  },

  // Pattern: (a)pply, (r)eject, (e)dit style
  {
    name: 'letter-in-parens',
    regex: /\(([a-z])\)([a-z]+)/gi,
    extract: (match, text) => {
      const options = [];
      const pattern = /\(([a-z])\)([a-z]+)/gi;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const letter = m[1].toLowerCase();
        const rest = m[2];
        const label = letter.toUpperCase() + rest;
        options.push({ label, value: letter });
      }
      return options.length >= 2 ? options : null;
    },
    priority: 8,
  },
];

const sortedPatterns = [...OPTION_PATTERNS].sort((a, b) => b.priority - a.priority);

function parseOptions(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const lines = text.trim().split('\n');
  const recentLines = lines.slice(-50).join('\n');

  for (const pattern of sortedPatterns) {
    const match = recentLines.match(pattern.regex);
    if (match) {
      const options = pattern.extract(match, recentLines);
      if (options && options.length > 0) {
        return {
          prompt: 'Select option:',
          options,
          patternName: pattern.name,
        };
      }
    }
  }

  return null;
}

function containsTrigger(text) {
  return parseOptions(text) !== null;
}

function addPattern(pattern) {
  if (!pattern.name || !pattern.regex || !pattern.extract) {
    throw new Error('Pattern must have name, regex, and extract properties');
  }
  pattern.priority = pattern.priority || 5;
  OPTION_PATTERNS.push(pattern);
  sortedPatterns.length = 0;
  sortedPatterns.push(...[...OPTION_PATTERNS].sort((a, b) => b.priority - a.priority));
}

module.exports = {
  parseOptions,
  containsTrigger,
  addPattern,
  OPTION_PATTERNS,
};
