# Terminal Rendering Fix Report - iOS PWA

## Project Overview
**OnClaude** - A mobile web app (PWA) to control Claude Code remotely from an iPhone. Uses WebSocket to communicate with a Node.js backend that spawns a PTY running Claude Code.

## The Problem
The terminal output on iOS Safari PWA was broken:
- xterm.js doesn't scroll on iOS PWA (known architectural issue)
- Switched to simple HTML `<pre>` element with ansi_up for colors
- But output showed raw escape sequences like `[?2026h]` and animation frame spam

---

## Session Timeline (27 iterations)

### Iteration 1-2: Initial Implementation
**Plan given:** Replace xterm.js with HTML-based terminal, handle escape sequences and carriage returns.

**What I did:**
- Updated `stripAnsi()` to handle bare DEC sequences (without ESC byte)
- Added line-aware buffering (wait for `\n` before rendering)
- Added 500ms force-flush for prompts

**Result:** Terminal was completely empty.

**Why it failed:** Line-aware buffering waited for newlines that never came during streaming output. Claude Code sends data in small chunks without `\n`.

---

### Iteration 3-4: Debug Panel
**Added on-screen debug panel** since iOS PWA has no console access.

**Debug output revealed:**
```
Raw len:53 |?[?2026h??[1C?[1A?[38;2;255;255;255m*?[39m????[?2026l|
After strip len:37
After CR len:1
HTML len:1 trim:0
SKIPPED - empty
```

**Root cause found:** The `\r` handling split on carriage return and took the LAST part. But data like `✶\r\r\r\r` splits to `['✶', '', '', '', '']` and last part is empty string.

---

### Iteration 5-6: CR Handling Fix
**Fixed:** Take last NON-EMPTY part after splitting by `\r`:
```javascript
let parts = line.split('\r').filter(p => p.length > 0);
return parts.length > 0 ? parts[parts.length - 1] : '';
```

**Result:** Content appeared! But massive spinner spam:
```
✢
*
✶
✻
Thinking…
Thinking…
Garnishing…
```

---

### Iteration 7-10: Spinner Filtering (Wrong Approach)
**My mistake:** I tried to filter specific words:
- "Thinking"
- "Garnishing"
- "Loading"
- "Composing"

**User correctly called me out:** "they use any fucking random word as status update... You cant write every fucking verb"

---

### Iteration 11-12: Pattern-Based Filtering
**Correct approach:** Filter by PATTERN, not specific words:
```javascript
// If line starts with spinner AND remaining text < 50 chars, it's status noise
if (startsWithSpinner && noSpinner.length < 50) return false;

// Skip very short lines (fragments)
if (stripped.length < 15) return false;
```

**Result:** Much cleaner output.

---

### Iteration 13-14: Folder Memory Feature
**User request:** Remember last used folder.

**Implemented:**
- Save to localStorage on start
- Load and pre-fill on page load
- Added visible "Last: foldername" label

**Issue:** Code was outside init(), moved it inside.

---

### Iteration 15-17: Word Wrapping Issues
**Problem:** Text wrapping mid-word looked terrible.

**Attempt 1:** `white-space: pre` with horizontal scroll
- Result: Lines had tons of trailing whitespace, huge horizontal scroll

**Attempt 2:** Trim trailing whitespace from each line
- Result: Still too wide for iPhone

---

### Iteration 18-20: Mobile Optimization
**Problem:** Claude Code formats output for 80+ columns, iPhone is ~40 columns.

**Root cause found:** Code forced minimum 80 columns:
```javascript
cols: Math.max(cols, 80),  // WRONG
```

**Fixed:**
```javascript
cols: Math.max(cols, 40),  // Allow narrow terminals
```

**Also fixed CSS:**
- Font size: 11px
- Padding: 8px
- `white-space: pre-wrap` with `word-break: break-word`
- `overflow-x: hidden` (no horizontal scroll)

---

### Iteration 21-23: Auth Button Spam
**Problem:** Auth button kept appearing repeatedly.

**Cause:** URL detection ran on every data chunk, OAuth URLs have unique params so each looked "new".

**Fixed:**
```javascript
let urlShownThisSession = false;

function detectAndShowUrl(data) {
  if (urlShownThisSession) return;  // Only show once
  // ... detection logic ...
  urlShownThisSession = true;
}
```

---

### Iteration 24-27: iOS Repaint Issue (CURRENT)
**Problem:** User must press Enter to see any content. Own messages not visible.

**Attempted fixes:**
1. Reduced render delay from 50ms to 16ms
2. Force iOS repaint:
```javascript
terminal.style.transform = 'translateZ(0)';
void terminal.offsetHeight;  // Force reflow
```
3. Use `requestAnimationFrame` for scroll
4. Reduced min line filter from 15 to 5 chars

**Status:** Still not working properly.

---

## Current Code State

### Key Files Modified
- `app/public/app.js` - Terminal rendering, URL detection, folder memory
- `app/public/style.css` - Terminal styling for mobile
- `app/public/index.html` - Cache busting versions (v=56, CSS v=25)

### Current `flushTerminal()` Logic
1. Strip DEC private mode sequences (with and without ESC byte)
2. Handle `\r` - take last non-empty part
3. Trim trailing whitespace
4. Filter: spinner + short text (<50 chars) = noise
5. Filter: lines < 5 chars = fragments
6. Convert to HTML with ansi_up
7. Append to terminal
8. Force repaint
9. Scroll to bottom

### Current Terminal CSS
```css
#terminal {
  font-size: 11px;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: hidden;
  overflow-y: scroll;
  -webkit-overflow-scrolling: touch;
}
```

### Current Terminal Size
```javascript
cols: Math.max(cols, 40),  // Min 40 for mobile
rows: Math.max(rows, 20),
```

---

## Remaining Issues

1. **Terminal not updating until user interaction (Enter key)**
   - iOS Safari may be throttling/batching DOM updates
   - Force repaint tricks not working
   - May need to use a different rendering approach

2. **User's own input not visible**
   - PTY should echo input, but if terminal isn't updating, echo won't show
   - Related to issue #1

---

## Recommended Next Steps

1. **Investigate iOS Safari rendering**
   - Test if `setInterval` polling helps trigger updates
   - Try `IntersectionObserver` or `MutationObserver` tricks
   - Consider if the WebSocket `onmessage` is even firing

2. **Add more debugging**
   - Re-enable debug panel to confirm data is arriving
   - Log when `flushTerminal()` is called vs when DOM actually updates

3. **Alternative approaches**
   - Use `<textarea readonly>` instead of `<pre>` (different rendering path)
   - Use CSS `will-change: contents` to hint browser
   - Try rendering to canvas instead of DOM

4. **Test on actual device**
   - Behavior may differ between iOS Safari, iOS Chrome, PWA mode
   - Check if issue is PWA-specific or all iOS browsers

---

## Files Changed (from git status)
```
M app/public/app.js
M app/public/index.html
M app/public/style.css
```

---

## How to Test
```bash
docker compose up -d --build
```
Then on iPhone:
1. Open https://[domain] in Safari
2. Add to Home Screen
3. Open PWA
4. Login and start Claude Code
5. Check if text appears without pressing Enter
6. Check if typed messages are visible

---

## My Failures in This Session

1. **Didn't understand the full problem upfront** - Applied patches instead of analyzing
2. **Line-aware buffering was over-engineered** - Simple debounce was sufficient
3. **Word-specific filtering was wrong approach** - Should have used patterns immediately
4. **Didn't consider iOS rendering quirks early** - Force repaint should have been first thing to try
5. **Too many iterations** - 27 round-trips for what should have been 5-6 max

---

*Report generated after 27 iterations of debugging. Handover requested by user.*
