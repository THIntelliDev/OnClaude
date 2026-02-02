/**
 * Sends push notifications via ntfy
 */
class Notifier {
  constructor(options = {}) {
    this.server = options.server || 'https://ntfy.sh';
    this.topic = options.topic;
    this.token = options.token || null;
    this.debounceSeconds = options.debounceSeconds || 30;
    this.clickUrl = options.clickUrl || null;

    // Debounce state
    this.lastNotificationHash = null;
    this.lastNotificationTime = 0;

    // Statistics
    this.stats = {
      sent: 0,
      debounced: 0,
      failed: 0,
    };

    if (!this.topic) {
      console.warn('[Notifier] No topic configured - notifications disabled');
    }
  }

  /**
   * Send a notification
   * @param {object} options - Notification options
   * @param {string} options.prompt - The prompt text to send
   * @param {string} options.title - Optional title override
   * @param {string} options.priority - Priority level (min, low, default, high, max)
   * @param {boolean} options.force - Skip debounce check
   * @returns {Promise<object>} - Result of the notification attempt
   */
  async notify({ prompt, title, priority = 'high', force = false }) {
    if (!this.topic) {
      return { success: false, reason: 'no_topic' };
    }

    const promptHash = this._hashString(prompt);
    const now = Date.now();
    const timeSinceLastMs = now - this.lastNotificationTime;
    const timeSinceLastSec = timeSinceLastMs / 1000;

    // Debounce check
    if (!force) {
      if (
        promptHash === this.lastNotificationHash &&
        timeSinceLastSec < this.debounceSeconds
      ) {
        this.stats.debounced++;
        console.log(
          `[Notifier] Debounced (same prompt, ${timeSinceLastSec.toFixed(1)}s since last)`
        );
        return { success: false, reason: 'debounced' };
      }
    }

    // Prepare notification
    const url = `${this.server.replace(/\/$/, '')}/${this.topic}`;
    const body = this._truncate(prompt, 200);
    const headers = {
      Title: title || 'Claude Code - Input Needed',
      Priority: priority,
      Tags: 'robot',
    };

    if (this.clickUrl) {
      headers['Click'] = this.clickUrl;
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });

      if (response.ok) {
        this.lastNotificationHash = promptHash;
        this.lastNotificationTime = now;
        this.stats.sent++;
        console.log(`[Notifier] Sent notification: "${body.substring(0, 50)}..."`);
        return { success: true };
      } else {
        const errorText = await response.text();
        this.stats.failed++;
        console.error(
          `[Notifier] Failed: ${response.status} ${response.statusText} - ${errorText}`
        );
        return {
          success: false,
          reason: 'http_error',
          status: response.status,
          error: errorText,
        };
      }
    } catch (error) {
      this.stats.failed++;
      console.error(`[Notifier] Error: ${error.message}`);
      return { success: false, reason: 'network_error', error: error.message };
    }
  }

  /**
   * Send a test notification
   * @returns {Promise<object>}
   */
  async test() {
    return this.notify({
      prompt: 'Test notification from Claude Code Mobile Controller',
      title: 'Claude Code - Test',
      priority: 'default',
      force: true,
    });
  }

  /**
   * Get notification statistics
   * @returns {object}
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset debounce state (useful after user interaction)
   */
  resetDebounce() {
    this.lastNotificationHash = null;
    this.lastNotificationTime = 0;
  }

  /**
   * Update configuration
   * @param {object} options
   */
  configure(options) {
    if (options.server !== undefined) this.server = options.server;
    if (options.topic !== undefined) this.topic = options.topic;
    if (options.token !== undefined) this.token = options.token;
    if (options.debounceSeconds !== undefined)
      this.debounceSeconds = options.debounceSeconds;
    if (options.clickUrl !== undefined) this.clickUrl = options.clickUrl;
  }

  /**
   * Truncate string to max length
   * @private
   */
  _truncate(str, maxLength) {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }

  /**
   * Simple string hash for comparison
   * @private
   */
  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }
}

module.exports = Notifier;
