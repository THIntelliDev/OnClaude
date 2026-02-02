const pty = require('node-pty');
const EventEmitter = require('events');

/**
 * Manages a PTY process for Claude Code with buffering and lifecycle management
 */
class PTYManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pty = null;
    this.bufferSize = options.bufferSize || 100 * 1024; // 100KB circular buffer
    this.buffer = Buffer.alloc(0);
    this.exitCode = null;
    this.running = false;
    this.cols = options.cols || 120;
    this.rows = options.rows || 40;
  }

  /**
   * Spawn a new PTY process
   * @param {string} command - Command to run (default: 'claude')
   * @param {string[]} args - Command arguments
   * @param {object} options - Spawn options
   */
  spawn(command = 'claude', args = [], options = {}) {
    if (this.running) {
      throw new Error('PTY already running. Call kill() first.');
    }

    const spawnOptions = {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: options.cwd || '/workspace',
      env: { ...process.env, ...options.env },
    };

    try {
      this.pty = pty.spawn(command, args, spawnOptions);
      this.running = true;
      this.exitCode = null;
      this.buffer = Buffer.alloc(0);

      this.pty.onData((data) => {
        this._appendToBuffer(data);
        this.emit('data', data);
      });

      this.pty.onExit(({ exitCode, signal }) => {
        this.running = false;
        this.exitCode = exitCode;
        this.emit('exit', { exitCode, signal });
      });

      this.emit('spawn', { command, args });
      return true;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Write data to the PTY stdin
   * @param {string} data - Data to write
   */
  write(data) {
    if (!this.pty || !this.running) {
      throw new Error('PTY not running');
    }
    this.pty.write(data);
  }

  /**
   * Resize the PTY
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   */
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.pty && this.running) {
      this.pty.resize(cols, rows);
    }
  }

  /**
   * Kill the PTY process
   * @param {string} signal - Signal to send (default: SIGTERM)
   */
  kill(signal = 'SIGTERM') {
    if (this.pty && this.running) {
      this.pty.kill(signal);
      this.running = false;
    }
  }

  /**
   * Get the buffered output
   * @returns {string} The buffered output as a string
   */
  getBuffer() {
    return this.buffer.toString('utf8');
  }

  /**
   * Get the current state of the PTY
   * @returns {object} State object
   */
  getState() {
    return {
      running: this.running,
      exitCode: this.exitCode,
      bufferLength: this.buffer.length,
      cols: this.cols,
      rows: this.rows,
    };
  }

  /**
   * Check if PTY is running
   * @returns {boolean}
   */
  isRunning() {
    return this.running;
  }

  /**
   * Append data to the circular buffer
   * @private
   */
  _appendToBuffer(data) {
    const newData = Buffer.from(data);
    const combined = Buffer.concat([this.buffer, newData]);

    if (combined.length > this.bufferSize) {
      // Keep only the last bufferSize bytes
      this.buffer = combined.slice(combined.length - this.bufferSize);
    } else {
      this.buffer = combined;
    }
  }
}

module.exports = PTYManager;
