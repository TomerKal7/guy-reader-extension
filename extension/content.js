// Guy_reader - In-Page Reader Content Script (Manifest V3)

(function () {
  if (window.__guyReaderInitialized) return;
  window.__guyReaderInitialized = true;

  // Local Speech Engine URL
  const SPEECH_ENGINE_URL = 'http://127.0.0.1:5050';

  // Reader State
  const state = {
    isActive: false,
    isPlaying: false,
    isPaused: false,
    speed: 1.0,
    voice: 'af_sarah', // Default to Kokoro Sarah for English
    sentences: [],
    currentIndex: -1,
    audioElement: null,
    currentSpeechUtterance: null,
    sequenceId: 0,
    pillEl: null,
    wordTimer: null,
    synchronized: false,
    generation: 0,
    prefetch: new Map(),
    lastPoint: null,
    wordOffset: 0,
    lastReportedState: '',
    engineAvailable: false, // Will be set after health check
    cleanReaderMode: false,
    cleanReaderOriginal: null, // Stashed original DOM for toggle-back
    sentenceTransitionTimer: null,
    lastSelection: null,
    isSelectionMode: false,
    elevenApiKey: '',
  };

  chrome.storage?.local.get({ guy_reader_sync: false, guy_reader_voice: 'af_sarah', guy_reader_eleven_key: '', guy_reader_speed: 1.0 }, prefs => {
    state.synchronized = prefs.guy_reader_sync;
    state.voice = prefs.guy_reader_voice;
    state.elevenApiKey = prefs.guy_reader_eleven_key || '';
    if (typeof prefs.guy_reader_speed === 'number' && !isNaN(prefs.guy_reader_speed)) {
      state.speed = Math.max(0.5, Math.min(2.5, Math.round(prefs.guy_reader_speed * 10) / 10));
    }
  });

  // 1. Sentence Splitting Helper
  function splitIntoSentences(text) {
    if (!text || !text.trim()) return [];
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 1. Protect numbers with decimals and multi-dot dates (e.g. 3.5, 7.10, 7.10.2023, $19.99)
    while (/(\d)\.(\d)/.test(text)) {
      text = text.replace(/(\d)\.(\d)/g, (m, d1, d2) => d1 + '\uE000' + d2);
    }

    // 2. Protect email addresses
    text = text.replace(/([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/g, (m) => m.replace(/\./g, '\uE000'));

    // 3. Protect URLs and domains
    text = text.replace(/(https?:\/\/[^\s]+)/gi, (m) => m.replace(/\./g, '\uE000'));
    text = text.replace(/([a-zA-Z0-9_-]+\.(?:com|org|net|io|co|il|edu|gov|ai|app|dev|me)[^\s]*)/gi, (m) => m.replace(/\./g, '\uE000'));

    // 4. Protect a.m. / p.m.
    text = text.replace(/\b([ap]\.m\.)/gi, (m) => m.replace(/\./g, '\uE000'));

    // 5. Protect English single letter initials followed by capital letter
    text = text.replace(/\b([A-Z])\.\s+(?=[A-Z])/g, '$1\uE000 ');

    // 6. Protect Hebrew initials followed by Hebrew word (e.g. א. כהן, י. שמעוני)
    text = text.replace(/(^|[\s("״'׳])([א-ת])\.\s+(?=[א-ת])/g, (m, p1, p2) => p1 + p2 + '\uE000 ');

    // 7. Protect common English abbreviations & titles
    const englishAbbrevs = [
      'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'vs', 'etc',
      'u.s.', 'u.s', 'e.g.', 'e.g', 'i.e.', 'i.e',
      'inc', 'ltd', 'corp', 'co', 'gen', 'col', 'gov', 'sen', 'rep',
      'st', 'ave', 'blvd', 'dept', 'no', 'fig', 'vol', 'al',
      'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
    ];
    englishAbbrevs.forEach(abbr => {
      const esc = abbr.replace(/\./g, '\\.');
      const regex = new RegExp('\\b' + esc + (abbr.endsWith('.') ? '' : '\\.'), 'gi');
      text = text.replace(regex, (m) => m.replace(/\./g, '\uE000'));
    });

    // 8. Protect Hebrew title abbreviations before names (e.g. פרופ., ופרופ., ד"ר., עו"ד., וכו.)
    const hebrewDotAbbrs = [
      /(^|[\s("״'׳])([בלמכושה]?פרופ)\./g,
      /(^|[\s("״'׳])([בלמכושה]?ד["״'׳]ר)\./g,
      /(^|[\s("״'׳])([בלמכושה]?עו["״'׳]ד)\./g,
      /(^|[\s("״'׳])([בלמכושה]?רו["״'׳]ח)\./g,
      /(^|[\s("״'׳])(וכו)\./g
    ];
    hebrewDotAbbrs.forEach(regex => {
      text = text.replace(regex, (m, p1, p2) => p1 + p2 + '\uE000');
    });

    // 9. Protect dialogue quotes ending in punctuation when followed by lowercase attribution
    text = text.replace(/([.!?׃]['"”’\)\]]*)\s+([a-z])/g, (match, p1, p2) => {
      return p1.replace(/\./g, '\uE000').replace(/!/g, '\uE001').replace(/\?/g, '\uE002') + ' ' + p2;
    });

    // 10. Split on terminal punctuation, semicolons, and bullet clause markers: . ! ? ; ׃ • ▪ ▫ ◆ ◇ ✦
    const regex = /([^.!?\n;׃•▪▫◆◇✦]+(?:[.!?;׃•▪▫◆◇✦]+['"”’\)\]]*|(?=[\n]|$))|[^.!?\n;׃•▪▫◆◇✦]+$)/g;
    const matches = text.match(regex) || [text];

    const baseSentences = matches
      .map(s => s.replace(/\uE000/g, '.').replace(/\uE001/g, '!').replace(/\uE002/g, '?').replace(/^[•▪▫◆◇✦\s\t-]+|[•▪▫◆◇✦\s\t-]+$/gu, '').trim())
      .filter(s => s.length > 0 && /[\p{L}\p{N}]/u.test(s));

    // 11. Break overly long sentences (> 200 chars) at natural comma/clause boundaries so they load fast
    const finalSentences = [];
    for (const s of baseSentences) {
      let rem = s;
      while (rem.length > 200) {
        let depth = 0;
        let splitAt = -1;
        // Look for a comma or dash outside parentheses between char 90 and 195
        for (let i = 0; i < Math.min(rem.length - 35, 195); i++) {
          const ch = rem[i];
          if (ch === '(' || ch === '[') depth++;
          else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
          else if (depth === 0 && i >= 90 && (ch === ',' || ch === ':' || (ch === '-' && rem[i - 1] === ' ' && rem[i + 1] === ' '))) {
            splitAt = i + 1;
          }
        }
        // Fallback if no comma found outside parens and string is very long (> 240 chars): split at word boundary around 160
        if (splitAt < 0 && rem.length > 240) {
          depth = 0;
          for (let i = 100; i < Math.min(rem.length - 35, 185); i++) {
            const ch = rem[i];
            if (ch === '(' || ch === '[') depth++;
            else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
            else if (depth === 0 && ch === ' ') {
              splitAt = i;
            }
          }
        }
        if (splitAt < 0) break;
        const left = rem.slice(0, splitAt).trim();
        const right = rem.slice(splitAt).trim();
        if (!left || !right) break;
        finalSentences.push(left);
        rem = right;
      }
      if (rem) finalSentences.push(rem);
    }

    return finalSentences;
  }

  function isHebrew(text) {
    return /[\u0590-\u05FF]/.test(text);
  }

  function readableSource(root, junkSelectors) {
    let text = '';
    const segments = [];
    const blockTags = new Set(['P','DIV','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','SECTION','ARTICLE']);
    const appendSeparator = () => { if (text && !/\s$/u.test(text)) text += ' '; };
    const hidden = element => {
      if (!element) return false;
      if (element.closest?.(junkSelectors) || element.hidden || element.getAttribute?.('aria-hidden') === 'true') return true;
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(element);
        if (style?.display === 'none' || style?.visibility === 'hidden') return true;
      }
      return false;
    };
    const appendText = node => {
      if (hidden(node.parentElement)) return;
      const value = node.textContent || '';
      if (!value) return;
      const start = text.length;
      text += value;
      segments.push({node, textStart:start, textEnd:text.length});
    };
    const visit = node => {
      if (node.nodeType === 3) { appendText(node); return; }
      if (node !== root && hidden(node)) return;
      const tag = node.tagName?.toUpperCase?.();
      if (tag === 'BR') { appendSeparator(); return; }
      const block = node !== root && blockTags.has(tag);
      if (block) appendSeparator();
      for (const child of Array.from(node.childNodes || [])) visit(child);
      if (block) appendSeparator();
    };
    if (root.childNodes) visit(root);
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) appendText(node);
    }
    return {text, segments};
  }

  // Helper to expand truncated tweets/posts on X before extraction
  function expandXTruncatedContent(root = document) {
    try {
      const showMoreBtns = Array.from(root.querySelectorAll?.('[data-testid="tweet-text-show-more-link"], [data-testid="tweet-text-show-more"], [data-testid*="show-more"]') || []);
      for (const btn of showMoreBtns) {
        if (btn && typeof btn.click === 'function' && !btn.disabled) {
          btn.click();
        }
      }
      const allButtons = Array.from(root.querySelectorAll?.('button[data-testid*="show-more"], article button, button[role="button"]') || []);
      for (const btn of allButtons) {
        const t = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if ((t === 'show more' || t === 'הצג עוד' || t.includes('show more')) && typeof btn.click === 'function' && !btn.disabled) {
          btn.click();
        }
      }
    } catch (_) {}
  }

  // 2. Full Article DOM Extractor
  function extractArticleData() {
    const cleanOverlay = document.getElementById('guy-reader-clean-overlay');
    if (cleanOverlay) {
      const cleanParas = cleanOverlay.querySelectorAll('.guy-reader-clean-title, .guy-reader-clean-para');
      if (cleanParas && cleanParas.length > 0) {
        const sentences = [];
        for (const el of cleanParas) {
          const source = readableSource(el, '');
          const fullText = source.text;
          if (!fullText || fullText.length < 2) continue;
          const subSentences = splitIntoSentences(fullText);
          let searchFrom = 0;
          for (let s of subSentences) {
            const start = fullText.indexOf(s, searchFrom);
            if (start < 0) continue;
            searchFrom = start + s.length;
            sentences.push({
              start, end: searchFrom,
              text: s,
              element: el,
              originalText: fullText,
              source
            });
          }
        }
        if (sentences.length > 0) return sentences;
      }
    }

    const mainSelectors = '.available-content, .body.markup, article, [role="main"], main, .article-body, .post-content, .entry-content, #content, .story-body, .single-post, .post';
    const host = window.location?.hostname || '';
    const isX = host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com');
    if (isX) {
      expandXTruncatedContent(document);
    }
    const pointNode = state.lastPoint?.node;
    const pointElement = pointNode?.nodeType === 1 ? pointNode : pointNode?.parentElement;
    const xSelector = '[data-testid="twitterArticleReadView"], [data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"], article[data-testid="tweet"], article';
    let mainContainer = isX ? pointElement?.closest?.(xSelector) : null;
    if (!mainContainer && isX) {
      const candidates = Array.from(document.querySelectorAll(xSelector));
      mainContainer = candidates
        .filter(el => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0)
        .sort((a,b) => (b.innerText || b.textContent || '').length - (a.innerText || a.textContent || '').length)[0];
    }
    if (!mainContainer) mainContainer = document.querySelector(mainSelectors);
    if (!mainContainer) mainContainer = document.body;
    if (isX && mainContainer) {
      expandXTruncatedContent(mainContainer);
    }

    const blockSelector = isX
      ? '[data-testid="tweetText"], [data-testid="longformRichTextComponent"] [class*="longform-"], [data-testid="twitterArticleReadView"] [class*="longform-"], [class*="longform-unstyled"], [class*="longform-header-"], [class*="longform-blockquote"], section[data-block="true"], p, h1, h2, h3, h4, blockquote, li'
      : 'p, h1, h2, h3, h4, blockquote, li';
    let blockElements = Array.from(mainContainer.querySelectorAll(blockSelector));
    if (isX && blockElements.length > 1) {
      blockElements = blockElements.filter(el => !blockElements.some(other => other !== el && el.contains(other)));
    }
    const sentences = [];

    const junkSelectors = 'nav, footer, aside, .nav, .menu, .sidebar, .comments, .ad, .advertisement, script, style, noscript, svg, [aria-hidden="true"], .timestamp, time, button, [role="tab"], [role="tablist"], [data-testid="ScrollSnap-List"]';

    for (let el of blockElements) {
      if (el.closest(junkSelectors)) continue;
      if (el.closest('#guy-reader-floating-pill')) continue;
      if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) continue;

      const source = readableSource(el, junkSelectors);
      const fullText = source.text;
      if (!fullText || fullText.length < 5) continue;
      if (isX && /^(Article|Conversation)$/iu.test(fullText.trim())) continue;

      const subSentences = splitIntoSentences(fullText);
      let searchFrom = 0;
      for (let s of subSentences) {
        const start = fullText.indexOf(s, searchFrom);
        if (start < 0) continue;
        searchFrom = start + s.length;
        sentences.push({
          start, end: searchFrom,
          text: s,
          element: el,
          originalText: fullText,
          source
        });
      }
    }

    // Fallback: If container returned nothing, scan all candidate content blocks in document
    if (sentences.length === 0) {
      const candidates = Array.from(document.querySelectorAll('p, h1, h2, h3, h4, blockquote, div, section, td'));
      for (let el of candidates) {
        if (el.closest(junkSelectors)) continue;
        if (el.closest('#guy-reader-floating-pill, #guy-reader-selection-btn')) continue;
        if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
        if (el.tagName === 'DIV' || el.tagName === 'SECTION') {
          if (el.querySelector('p, h1, h2, h3, h4, blockquote, div, section')) continue;
        }
        const source = readableSource(el, junkSelectors);
        const fullText = source.text;
        if (fullText && fullText.length >= 10 && /[\p{L}\p{N}]/u.test(fullText)) {
          const subSentences = splitIntoSentences(fullText);
          let searchFrom = 0;
          for (let s of subSentences) {
            const start = fullText.indexOf(s, searchFrom);
            if (start < 0) continue;
            searchFrom = start + s.length;
            sentences.push({
              start, end: searchFrom,
              text: s,
              element: el,
              originalText: fullText,
              source
            });
          }
        }
      }
    }

    return sentences;
  }

  // Check if local speech engine is running (routed via background.js to bypass webpage CSP)
  function checkLocalEngine() {
    try {
      chrome.runtime.sendMessage({ action: 'check-engine-health' }, (resp) => {
        if (chrome.runtime.lastError) {
          state.engineAvailable = false;
          return;
        }
        state.engineAvailable = !!(resp && resp.available);
        console.log('[GuyReader] Local engine:', state.engineAvailable ? 'available' : 'unavailable');
      });
    } catch (e) {
      state.engineAvailable = false;
      console.log('[GuyReader] Local engine not reachable, using Web Speech fallback');
    }
  }

  // Probe engine on load
  checkLocalEngine();

  // Find sentence index matching user selection
  function getSelectionSentenceIndex(sentences) {
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return 0;

    const selectedText = sel.toString().trim();
    if (!selectedText) return 0;

    const anchorNode = sel.anchorNode;
    const anchorEl = anchorNode ? (anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement) : null;

    // Check by DOM node match first
    if (anchorEl) {
      for (let i = 0; i < sentences.length; i++) {
        if (sentences[i].element === anchorEl || sentences[i].element.contains(anchorEl) || anchorEl.contains(sentences[i].element)) {
          return i;
        }
      }
    }

    // Fallback: match by substring
    const sample = selectedText.slice(0, 30);
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i].text.includes(sample) || sample.includes(sentences[i].text.slice(0, 20))) {
        return i;
      }
    }

    return 0;
  }

  // Extract sentences directly from user's text selection (ensuring 100% detection regardless of DOM container tags)
  function extractSelectionData(explicitText = null) {
    let text = (typeof explicitText === 'string' && explicitText.trim().length > 0)
      ? explicitText.trim()
      : null;

    let range = null;
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const sText = sel.toString().trim();
      if (sText.length > 0) {
        if (!text) text = sText;
        try { range = sel.getRangeAt(0).cloneRange(); } catch (_) {}
      }
    }

    if (!text && state.lastSelection && (Date.now() - (state.lastSelection.time || 0) < 120000)) {
      text = state.lastSelection.text;
      range = state.lastSelection.range;
    }

    if (!text || !/[\p{L}\p{N}]/u.test(text)) return null;

    const subSentences = splitIntoSentences(text);
    const sentenceTexts = subSentences.length > 0 ? subSentences : [text];

    let commonEl = document.body;
    const segments = [];

    if (range) {
      try {
        const common = range.commonAncestorContainer;
        commonEl = common.nodeType === 1 ? common : (common.parentElement || document.body);

        if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
          const node = range.startContainer;
          const val = node.textContent.substring(range.startOffset, range.endOffset);
          segments.push({
            node,
            textStart: 0,
            textEnd: val.length,
            nodeOffsetStart: range.startOffset
          });
        } else {
          const walker = document.createTreeWalker(
            commonEl,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode: (n) => {
                try {
                  if (range.intersectsNode && !range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
                } catch (_) {}
                return NodeFilter.FILTER_ACCEPT;
              }
            }
          );
          let curr;
          let accum = '';
          while ((curr = walker.nextNode())) {
            const sOff = (curr === range.startContainer) ? range.startOffset : 0;
            const eOff = (curr === range.endContainer) ? range.endOffset : curr.textContent.length;
            if (eOff > sOff) {
              const val = curr.textContent.substring(sOff, eOff);
              if (accum && !/\s$/u.test(accum) && !/^\s/u.test(val)) {
                accum += ' ';
              }
              const sStart = accum.length;
              accum += val;
              segments.push({
                node: curr,
                textStart: sStart,
                textEnd: accum.length,
                nodeOffsetStart: sOff
              });
            }
          }
        }
      } catch (_) {}
    }

    const sentences = [];
    let searchFrom = 0;
    for (const s of sentenceTexts) {
      const start = text.indexOf(s, searchFrom);
      const sStart = start >= 0 ? start : searchFrom;
      const sEnd = sStart + s.length;
      searchFrom = sEnd;

      sentences.push({
        start: sStart,
        end: sEnd,
        text: s,
        element: commonEl,
        originalText: text,
        source: { text, segments, isSelection: true }
      });
    }

    return sentences.length > 0 ? sentences : null;
  }

  // Ranges highlight the original DOM without wrapping, rewriting, or shifting text.
  function sourceRange(item, offset, length) {
    if (!item || !document.createRange) return null;
    const start = item.start + offset, end = start + length;
    const segments = item.source?.segments || [];
    if (segments.length === 0) {
      if (item.element && item.element !== document.body) {
        try {
          const r = document.createRange();
          r.selectNodeContents(item.element);
          return r;
        } catch (_) {}
      }
      return null;
    }
    const startSegment = segments.find(s => start >= s.textStart && start < s.textEnd) ||
      segments.find(s => s.textStart > start);
    const endSegment = [...segments].reverse().find(s => end > s.textStart && end <= s.textEnd) ||
      [...segments].reverse().find(s => end > s.textEnd < end);
    if (!startSegment || !endSegment) return null;
    const sOffsetStart = startSegment.nodeOffsetStart || 0;
    const eOffsetStart = endSegment.nodeOffsetStart || 0;
    const startOffset = Math.max(0, start - startSegment.textStart) + sOffsetStart;
    const endOffset = Math.min(
      endSegment.node.textContent.length,
      (end - endSegment.textStart) + eOffsetStart
    );
    try {
      const range = document.createRange();
      range.setStart(startSegment.node, Math.min(startOffset, startSegment.node.textContent.length));
      range.setEnd(endSegment.node, Math.min(Math.max(startOffset, endOffset), endSegment.node.textContent.length));
      return range;
    } catch (_) {
      return null;
    }
  }

  function paintRange(name, range) {
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
      if (range) CSS.highlights.set(name, new Highlight(range));
      else CSS.highlights.delete(name);
    }
  }

  function clearOnPageHighlights() {
    paintRange('guy-reader-sentence', null);
    paintRange('guy-reader-word', null);
    const overlay = document.getElementById('guy-reader-clean-overlay');
    if (overlay) {
      overlay.querySelectorAll('.guy-reader-sentence-active').forEach(el => el.classList.remove('guy-reader-sentence-active'));
      overlay.querySelectorAll('.guy-reader-word-active').forEach(el => el.classList.remove('guy-reader-word-active'));
    }
  }

  function highlightSentenceOnPage(index) {
    clearOnPageHighlights();
    const item = state.sentences[index];
    if (!item) return;
    paintRange('guy-reader-sentence', sourceRange(item, 0, item.text.length));

    const overlay = document.getElementById('guy-reader-clean-overlay');
    if (overlay) {
      const cleanSent = overlay.querySelector(`[data-guy-sentence="${index}"]`);
      if (cleanSent) {
        cleanSent.classList.add('guy-reader-sentence-active');
        const oRect = cleanSent.getBoundingClientRect();
        if (oRect.top < 100 || oRect.bottom > window.innerHeight - 100) {
          cleanSent.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      return;
    }

    const rect = item.element?.getBoundingClientRect?.();
    if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) {
      item.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function highlightWordAt(characterIndex) {
    const item = state.sentences[state.currentIndex];
    if (!item) return;
    const words = [...item.text.matchAll(/\S+/gu)];
    const word = words.find(w => characterIndex >= w.index && characterIndex < w.index + w[0].length);
    if (word) {
      state.wordOffset = word.index;
      paintRange('guy-reader-word', sourceRange(item, word.index, word[0].length));

      const overlay = document.getElementById('guy-reader-clean-overlay');
      if (overlay) {
        overlay.querySelectorAll('.guy-reader-word-active').forEach(el => el.classList.remove('guy-reader-word-active'));
        const cleanWord = overlay.querySelector(`[data-guy-sentence="${state.currentIndex}"] [data-guy-word="${word.index}"]`);
        if (cleanWord) {
          cleanWord.classList.add('guy-reader-word-active');
        }
      }
    }
  }

  function offsetInSource(source, node, offset) {
    const segment = source?.segments?.find(s => s.node === node);
    if (segment) return segment.textStart + Math.min(offset, segment.node.textContent.length);
    return -1;
  }

  function pointPosition(point) {
    if (!point) return null;
    let node = point.node, offset = point.offset;
    if (!node) {
      const caret = document.caretPositionFromPoint?.(point.x, point.y);
      const range = !caret && document.caretRangeFromPoint?.(point.x, point.y);
      node = caret?.offsetNode || range?.startContainer;
      offset = caret?.offset ?? range?.startOffset;
    }
    if (!node) return null;
    for (let i = 0; i < state.sentences.length; i++) {
      const item = state.sentences[i];
      if (!item.element.contains(node)) continue;
      const at = offsetInSource(item.source, node, offset);
      if (at >= item.start && at < item.end) {
        const relative = at - item.start;
        const word = [...item.text.matchAll(/\S+/gu)].find(w => relative < w.index + w[0].length);
        return { index: i, offset: word?.index || 0 };
      }
    }
    return null;
  }

  // Remember a reading origin even before playback starts. Ordinary page links still work.
  function setupClickToSeek() {
    document.addEventListener('click', e => {
      if (e.target.closest('#guy-reader-floating-pill, #guy-reader-selection-btn, input, textarea, select, button, a, [contenteditable="true"]')) return;
      const caret = document.caretPositionFromPoint?.(e.clientX, e.clientY);
      const range = !caret && document.caretRangeFromPoint?.(e.clientX, e.clientY);
      chrome.runtime.sendMessage({ action: 'reader-focus' }, () => { void chrome.runtime.lastError; });
      state.lastPoint = {
        node: caret?.offsetNode || range?.startContainer,
        offset: caret?.offset ?? range?.startOffset, x: e.clientX, y: e.clientY
      };
      if (!state.isActive) return;
      const position = pointPosition(state.lastPoint);
      if (position) playSentence(position.index, false, position.offset);
    }, true);
  }

  function extractClickedOrSelectedText() {
    const selection = window.getSelection?.();
    const selText = selection && !selection.isCollapsed ? selection.toString().trim() : '';
    if (selText.length > 0) return selText;
    if (state.lastSelection && (Date.now() - (state.lastSelection.time || 0) < 120000) && state.lastSelection.text) {
      return state.lastSelection.text;
    }

    state.sentences = extractArticleData();
    if (!state.sentences || state.sentences.length === 0) return '';

    let startIndex = 0, startOffset = 0;
    const point = pointPosition(state.lastPoint);
    if (point) {
      startIndex = point.index;
      startOffset = point.offset;
    } else {
      startIndex = getSelectionSentenceIndex(state.sentences);
    }

    const parts = [];
    for (let i = startIndex; i < state.sentences.length; i++) {
      const s = state.sentences[i]?.text || '';
      if (!s) continue;
      parts.push(i === startIndex && startOffset > 0 ? s.slice(startOffset).trim() : s);
    }
    return parts.filter(Boolean).join(' ').trim();
  }

  // 5. Speech Playback Core
  function startReading(fromSelection = true, explicitText = null) {
    getAudioContext();
    if (!state.sharedAudio && typeof Audio !== 'undefined') {
      state.sharedAudio = new Audio();
    }
    stopReading();
    hideSelectionTooltip();
    state.currentIndex = -1;

    let selectedSentences = null;
    if (fromSelection || (explicitText && explicitText.trim().length > 0)) {
      selectedSentences = extractSelectionData(explicitText);
    }

    if (selectedSentences && selectedSentences.length > 0) {
      state.sentences = selectedSentences;
      state.isSelectionMode = true;
    } else {
      state.isSelectionMode = false;
      state.sentences = extractArticleData();
    }

    if (state.sentences.length === 0) {
      const isPdf = location.pathname.toLowerCase().endsWith('.pdf') || !!document.querySelector('embed[type*="pdf"]');
      if (isPdf) {
        alert("Guy Reader: בקובצי PDF בדפדפן, סמן את הטקסט שברצונך לשמוע, לחץ עליו עם המקש הימני בעכבר (קליק ימני) ובחר: '🔊 הקרא עם Guy Reader'.");
      } else {
        alert("Guy_reader: לא נמצא מלל לקריאה בעמוד זה.");
      }
      return;
    }

    let startIndex = 0, startOffset = 0;
    if (!state.isSelectionMode && fromSelection) {
      const point = pointPosition(state.lastPoint);
      if (point) { startIndex = point.index; startOffset = point.offset; }
      else startIndex = getSelectionSentenceIndex(state.sentences);
    }

    // Auto-detect language and pick voice
    const sampleText = state.sentences[startIndex]?.text || '';
    const he = isHebrew(sampleText);
    if (he && !state.voice.includes('he-')) {
      state.voice = 'edge-he-avri';
    } else if (!he && state.voice.includes('he-')) {
      state.voice = 'edge-en-jenny';
    }
    // Edge neural voices have a fixed identity but no word-boundary metadata.
    // Never replace a chosen Avri/Hila voice just to provide exact highlighting.
    if (state.voice.startsWith('edge-') && state.synchronized) {
      state.synchronized = false;
      chrome.storage?.local.set({guy_reader_sync:false});
      const mode = document.getElementById('guy-mode-select');
      if (mode) mode.value = 'neural';
    }

    state.isActive = true;
    showFloatingPill();
    updatePillUI();
    playSentence(startIndex, false, startOffset);
  }

  // Quick-read floating button on selection
  let selectionTooltipEl = null;

  function hideSelectionTooltip() {
    if (selectionTooltipEl) {
      selectionTooltipEl.style.display = 'none';
    }
  }

  function showSelectionTooltip(rect, fallbackX = null, fallbackY = null) {
    let top = 20, left = 20;
    if (rect && (rect.width > 0 || rect.height > 0)) {
      top = Math.max(8, rect.top > 44 ? rect.top - 40 : rect.bottom + 8);
      left = Math.max(10, Math.min(window.innerWidth - 120, rect.left + (rect.width / 2) - 48));
    } else if (typeof fallbackX === 'number' && typeof fallbackY === 'number') {
      top = Math.max(8, fallbackY - 42);
      left = Math.max(10, Math.min(window.innerWidth - 120, fallbackX - 48));
    } else {
      return;
    }

    if (!selectionTooltipEl) {
      selectionTooltipEl = document.createElement('div');
      selectionTooltipEl.id = 'guy-reader-selection-btn';
      selectionTooltipEl.innerHTML = `<span style="display:flex;align-items:center;gap:4px;">🔊 קרא מסומן</span>`;
      selectionTooltipEl.title = 'קרא מלל מסומן עם Guy Reader';
      selectionTooltipEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      selectionTooltipEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideSelectionTooltip();
        startReading(true);
      });
      (document.body || document.documentElement).appendChild(selectionTooltipEl);
    }

    selectionTooltipEl.style.top = `${top}px`;
    selectionTooltipEl.style.left = `${left}px`;
    selectionTooltipEl.style.display = 'flex';
  }

  function updateLastSelection() {
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const text = sel.toString().trim();
      if (text.length > 0) {
        state.lastSelection = {
          text,
          range: sel.getRangeAt(0).cloneRange(),
          time: Date.now()
        };
      }
    } catch (_) {}
  }

  function setupSelectionHandlers() {
    document.addEventListener('selectionchange', () => {
      updateLastSelection();
    }, { passive: true });

    document.addEventListener('mouseup', () => {
      updateLastSelection();
    }, { passive: true });
  }

  function stopReading() {
    if (typeof clearTimeout !== 'undefined' && state.sentenceTransitionTimer) {
      clearTimeout(state.sentenceTransitionTimer);
      state.sentenceTransitionTimer = null;
    }
    state.isActive = false;
    state.isPlaying = false;
    state.isPaused = false;
    state.sequenceId++;
    state.generation++;
    state.prefetch.clear();
    stopCurrentAudioOnly();
    clearOnPageHighlights();
    updatePillUI();
  }

  function pauseReading() {
    if (typeof clearTimeout !== 'undefined' && state.sentenceTransitionTimer) {
      clearTimeout(state.sentenceTransitionTimer);
      state.sentenceTransitionTimer = null;
    }
    state.isPaused = true;
    state.isPlaying = false;
    if (state.audioElement && !state.audioElement.paused) {
      state.audioElement.pause();
    }
    if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
    }
    if (state.wordTimer) {
      clearInterval(state.wordTimer);
      state.wordTimer = null;
    }
    updatePillUI();
  }

  function resumeReading() {
    if (state.isPaused && state.currentIndex >= 0) {
      state.isPaused = false;
      state.isPlaying = true;
      if (state.audioElement && state.audioElement.paused) {
        state.audioElement.play().catch(() => {});
      } else if ('speechSynthesis' in window && window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      } else {
        playSentence(state.currentIndex);
      }
      updatePillUI();
    } else if (state.sentences.length > 0) {
      playSentence(state.currentIndex >= 0 ? state.currentIndex : 0);
    } else {
      startReading(false);
    }
  }

  async function playSentence(index, continuous = false, offset = 0) {
    if (typeof clearTimeout !== 'undefined' && state.sentenceTransitionTimer) {
      clearTimeout(state.sentenceTransitionTimer);
      state.sentenceTransitionTimer = null;
    }
    if (index < 0 || index >= state.sentences.length) {
      stopReading();
      return;
    }

    if (!continuous) { state.generation++; state.prefetch.clear(); }
    const currentGen = state.generation;
    const mySeq = ++state.sequenceId;
    stopCurrentAudioOnly();
    state.currentIndex = index;
    state.isPlaying = true;
    state.isActive = true;
    state.isPaused = false;
    updatePillUI();

    const sentenceItem = state.sentences[index];
    state.wordOffset = offset;
    const textToSpeak = sentenceItem.text.slice(offset);
    const hebrewVoice = /he-|avri|hila|roboshaul|shaul/i.test(state.voice);
    const elevenVoice = state.voice && state.voice.startsWith('eleven-');
    const voice = elevenVoice ? state.voice : (isHebrew(textToSpeak)
      ? (hebrewVoice ? state.voice : 'edge-he-avri')
      : (hebrewVoice ? 'edge-en-jenny' : state.voice));

    highlightSentenceOnPage(index);
    if (state.synchronized && !isHebrew(textToSpeak) && !voice.startsWith('edge-') && !elevenVoice) {
      speakConnectedPassage(index, offset, mySeq);
      return;
    }

    // Try ElevenLabs synthesis if selected
    if (voice.startsWith('eleven-')) {
      if (!state.elevenApiKey) {
        const key = prompt('Please enter your free ElevenLabs API Key (from elevenlabs.io):');
        if (key && key.trim()) {
          state.elevenApiKey = key.trim();
          chrome.storage?.local.set({ guy_reader_eleven_key: state.elevenApiKey });
        }
      }
      if (state.elevenApiKey) {
        chrome.runtime.sendMessage({
          action: 'synthesize-elevenlabs',
          text: textToSpeak,
          voice: voice,
          key: state.elevenApiKey
        }, (resp) => {
          if (state.sequenceId !== mySeq) return;
          if (resp && resp.success && resp.audioDataUrl) {
            playAudioUrl(resp.audioDataUrl, textToSpeak, mySeq, false, offset);
          } else {
            console.warn('[GuyReader] ElevenLabs synthesis failed, falling back:', resp?.error);
            const fb = isHebrew(textToSpeak) ? 'edge-he-avri' : 'edge-en-jenny';
            chrome.runtime.sendMessage({
              action: 'synthesize-edge-tts',
              text: textToSpeak,
              voice: fb,
              rate: 1.0
            }, (edgeResp) => {
              if (state.sequenceId !== mySeq) return;
              if (edgeResp && edgeResp.success && edgeResp.audioDataUrl) {
                playAudioUrl(edgeResp.audioDataUrl, textToSpeak, mySeq, false, offset);
              } else {
                speakWebSpeech(textToSpeak, mySeq, offset);
              }
            });
          }
        });
        return;
      }
    }

    // 1. Fetch current sentence immediately and launch staggered parallel prefetch for next 4 sentences
    const currentAudioPromise = prefetchSentence(index, offset);
    scheduleLookaheadPrefetch(index, currentGen);
    const audioDataUrl = await currentAudioPromise;
    if (state.sequenceId !== mySeq) return; // Stale or canceled

    if (audioDataUrl) {
      scheduleLookaheadPrefetch(index, currentGen);
      playAudioUrl(audioDataUrl, textToSpeak, mySeq, true, offset);
      return;
    }

    // 2. Fallback direct synthesis with the exact same chosen voice (never switch voice mid-reading)
    const action = voice.startsWith('edge-') ? 'synthesize-edge-tts' : 'synthesize-local';
    chrome.runtime.sendMessage({
      action,
      text: textToSpeak,
      voice,
      speed: 1.0,
      rate: 1.0
    }, (resp) => {
      if (state.sequenceId !== mySeq) return;
      if (resp && resp.success && resp.audioDataUrl) {
        prefetchSentence(index + 1);
        playAudioUrl(resp.audioDataUrl, textToSpeak, mySeq, false, offset);
      } else {
        // Retry once with the SAME voice after a short pause (never switch to another voice or robotic WebSpeech)
        setTimeout(() => {
          if (state.sequenceId !== mySeq) return;
          chrome.runtime.sendMessage({
            action,
            text: textToSpeak,
            voice,
            speed: 1.0,
            rate: 1.0
          }, (retryResp) => {
            if (state.sequenceId !== mySeq) return;
            if (retryResp && retryResp.success && retryResp.audioDataUrl) {
              prefetchSentence(index + 1);
              playAudioUrl(retryResp.audioDataUrl, textToSpeak, mySeq, false, offset);
            } else {
              stopReading();
              showToastNotice('⚠️ שרת הקול ברקע לא הגיב. ודא ש-Launch_Guy_Reader.bat פועל.');
            }
          });
        }, 350);
      }
    });
  }

  function showToastNotice(text) {
    try {
      let toast = document.getElementById('guy-reader-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'guy-reader-toast';
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#18181b;color:#f43f5e;border:1px solid #e11d48;padding:12px 20px;border-radius:10px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:500;z-index:9999999;box-shadow:0 10px 25px rgba(0,0,0,0.5);direction:rtl;text-align:center;transition:opacity 0.3s;pointer-events:none;';
        document.body.appendChild(toast);
      }
      toast.textContent = text;
      toast.style.opacity = '1';
      toast.style.display = 'block';
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => { toast.style.display = 'none'; }, 300);
      }, 5000);
    } catch (_) {}
  }

  function speakConnectedPassage(index, offset, sequence) {
    const segments = [];
    let text = '';
    const hebrew = isHebrew(state.sentences[index].text);
    for (let i = index; i < state.sentences.length; i++) {
      const item = state.sentences[i];
      if (isHebrew(item.text) !== hebrew || (text.length && text.length + item.text.length > 2500)) break;
      const from = i === index ? offset : 0;
      if (text) text += ' ';
      segments.push({index:i, start:text.length, offset:from});
      text += item.text.slice(from);
    }
    speakWebSpeech(text, sequence, offset, segments);
  }

  function scheduleLookaheadPrefetch(fromIndex, gen = state.generation) {
    const maxAhead = Math.min(state.sentences.length - 1, fromIndex + 4);
    for (let i = fromIndex + 1, step = 0; i <= maxAhead; i++, step++) {
      const delay = 120 + step * 180;
      setTimeout(() => {
        if (state.isActive && state.generation === gen && i >= state.currentIndex) {
          prefetchSentence(i);
        }
      }, delay);
    }
  }

  function prefetchSentence(index, offset = 0) {
    const item = state.sentences[index];
    if (!item) return Promise.resolve(null);
    const isHeb = /he-|avri|hila|roboshaul|shaul/i.test(state.voice);
    const voice = isHebrew(item.text)
      ? (isHeb ? state.voice : 'edge-he-avri')
      : (isHeb ? 'edge-en-jenny' : state.voice);
    if (voice.startsWith('eleven-')) return Promise.resolve(null);
    const key = `${index}:${offset}:${voice}`;
    if (state.prefetch.has(key)) return state.prefetch.get(key);
    const generation = state.generation;
    const request = new Promise(resolve => {
      try {
        const action = voice.startsWith('edge-') ? 'synthesize-edge-tts' : 'synthesize-local';
        chrome.runtime.sendMessage({
          action,
          text: item.text.slice(offset),
          voice,
          speed: 1.0,
          rate: 1.0
        }, resp => {
          const audioUrl = (generation === state.generation && !chrome.runtime.lastError && resp?.success) ? resp.audioDataUrl : null;
          resolve(audioUrl);
          if (audioUrl && index + 1 < state.sentences.length && (state.currentIndex < 0 || index + 1 <= state.currentIndex + 4)) {
            prefetchSentence(index + 1);
          }
        });
      } catch (_) { resolve(null); }
    });
    state.prefetch.set(key, request);
    request.then(url => {
      if (!url && state.prefetch.get(key) === request) {
        state.prefetch.delete(key);
      }
    });
    // Keep a sliding window relative to currentIndex (never evict upcoming prefetched sentences!)
    const minKeep = Math.max(0, state.currentIndex - 1);
    for (const old of state.prefetch.keys()) {
      if (Number(old.split(':')[0]) < minKeep) state.prefetch.delete(old);
    }
    return request;
  }

  let audioCtx = null;
  function getAudioContext() {
    try {
      if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctx();
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    } catch (_) {
      return null;
    }
  }

  function dataUrlToBlob(dataUrl) {
    if (typeof atob === 'undefined' || typeof Blob === 'undefined') return null;
    const parts = dataUrl.split(',');
    if (parts.length < 2) return null;
    const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'audio/mp3';
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  }

  function stopCurrentAudioOnly() {
    if (state.activeSourceNode) {
      try {
        state.activeSourceNode.onended = null;
        state.activeSourceNode.stop();
      } catch (_) {}
      state.activeSourceNode = null;
    }
    if (state.audioElement) {
      state.audioElement.onplay = null;
      state.audioElement.onended = null;
      state.audioElement.onerror = null;
      try { state.audioElement.pause(); } catch (_) {}
    }
    if (state.currentSpeechUtterance) {
      state.currentSpeechUtterance.onend = null;
      state.currentSpeechUtterance.onerror = null;
      state.currentSpeechUtterance = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (state.wordTimer) {
      clearInterval(state.wordTimer);
      state.wordTimer = null;
    }
  }

  function playAudioUrl(url, text, seqId, isBlobUrl, offset = 0) {
    if (state.sequenceId !== seqId) return;

    let playableUrl = url;
    let createdBlobUrl = false;
    let rawBlob = null;

    if (url && typeof url === 'string' && url.startsWith('data:')) {
      try {
        rawBlob = dataUrlToBlob(url);
        if (rawBlob && typeof URL !== 'undefined' && URL.createObjectURL) {
          playableUrl = URL.createObjectURL(rawBlob);
          createdBlobUrl = true;
        }
      } catch (_) {
        playableUrl = url;
      }
    }

    const cleanup = () => {
      if (createdBlobUrl || isBlobUrl) {
        try { if (typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(playableUrl); } catch (_) {}
      }
    };

    const tryWebAudioFallback = async () => {
      try {
        const ctx = getAudioContext();
        if (!ctx) return false;
        if (ctx.state === 'suspended') {
          await Promise.race([
            ctx.resume().catch(() => {}),
            new Promise(r => setTimeout(r, 350))
          ]);
        }
        let arrayBuf = null;
        if (rawBlob && rawBlob.arrayBuffer) {
          arrayBuf = await rawBlob.arrayBuffer();
        } else if (url && url.startsWith('data:') && typeof atob !== 'undefined') {
          const bstr = atob(url.split(',')[1]);
          const u8arr = new Uint8Array(bstr.length);
          for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
          arrayBuf = u8arr.buffer;
        } else if (typeof fetch !== 'undefined') {
          const res = await fetch(url);
          arrayBuf = await res.arrayBuffer();
        }
        if (!arrayBuf) return false;

        const audioBuffer = await ctx.decodeAudioData(arrayBuf);
        if (state.sequenceId !== seqId) return true;
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.playbackRate.value = state.speed;
        source.connect(ctx.destination);
        source.onended = () => {
          cleanup();
          if (state.sequenceId !== seqId) return;
          if (state.wordTimer) clearInterval(state.wordTimer);
          onSentenceFinished();
        };
        const startedAt = ctx.currentTime;
        source.start(0);
        state.activeSourceNode = source;
        startWordTimer(text, {
          get currentTime() {
            return Math.max(0, (ctx.currentTime - startedAt) * (state.speed || 1.0));
          },
          duration: audioBuffer.duration
        }, offset);
        updatePillUI();
        return true;
      } catch (err) {
        console.warn('[GuyReader] Web Audio fallback failed:', err);
        return false;
      }
    };

    if (!state.sharedAudio && typeof Audio !== 'undefined') {
      state.sharedAudio = new Audio();
    }
    const audio = state.sharedAudio || new Audio();
    state.audioElement = audio;
    audio.onplay = null;
    audio.onended = null;
    audio.onerror = null;
    audio.src = playableUrl;
    audio.defaultPlaybackRate = state.speed;
    audio.playbackRate = state.speed;
    audio.onloadedmetadata = () => {
      audio.defaultPlaybackRate = state.speed;
      audio.playbackRate = state.speed;
    };

    audio.onplay = () => {
      if (state.sequenceId !== seqId || state.isPaused) {
        audio.pause();
        cleanup();
        return;
      }
      audio.defaultPlaybackRate = state.speed;
      audio.playbackRate = state.speed;
      startWordTimer(text, audio, offset);
      updatePillUI();
    };

    audio.onended = () => {
      cleanup();
      if (state.sequenceId !== seqId) return;
      if (state.wordTimer) clearInterval(state.wordTimer);
      onSentenceFinished();
    };

    audio.onerror = async (e) => {
      console.warn("Audio element error, attempting Web Audio fallback:", e);
      const recovered = await tryWebAudioFallback();
      if (recovered) return;

      cleanup();
      if (state.sequenceId !== seqId) return;
      console.warn('[GuyReader] Audio playback error, advancing to next sentence.');
      onSentenceFinished();
    };

    const playPromise = state.isPaused ? undefined : audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(async (err) => {
        if (state.sequenceId !== seqId) return;
        console.warn("Autoplay policy prevented audio.play(), trying Web Audio:", err);
        const recovered = await tryWebAudioFallback();
        if (recovered) return;

        cleanup();
        showFloatingPill();
        state.isPlaying = false;
        state.isPaused = true;
        updatePillUI();
      });
    }
  }

  function startWordTimer(text, audioEl, offset = 0) {
    if (state.wordTimer) clearInterval(state.wordTimer);
    // Neural audio without alignment metadata is explicitly an estimate, tied to media time.
    const words = [...text.matchAll(/\S+/gu)];
    const weights = words.map(w => Math.max(1, w[0].replace(/[^\p{L}\p{N}]/gu, '').length));
    const total = weights.reduce((a,b) => a+b, 0);
    const update = () => {
      if (state.isPaused || !Number.isFinite(audioEl.duration) || !audioEl.duration) return;
      let target = audioEl.currentTime / audioEl.duration * total, i = 0;
      while (i < weights.length - 1 && target >= weights[i]) target -= weights[i++];
      if (words[i]) highlightWordAt(offset + words[i].index);
    };
    update();
    state.wordTimer = setInterval(update, 40);
  }

  function speakWebSpeech(text, seqId, offset = 0, segments = null) {
    if (state.sequenceId !== seqId || state.isPaused) return;
    if (!('speechSynthesis' in window)) {
      onSentenceFinished();
      return;
    }

    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = state.speed;

    const voices = window.speechSynthesis.getVoices();
    const isHeb = isHebrew(text);
    if (isHeb) {
      // Carmit is strictly eliminated. Never speak Hebrew via Web Speech fallback on macOS.
      console.warn('[GuyReader] Web Speech Hebrew (Carmit) is disabled.');
      onSentenceFinished();
      return;
    }
    utt.lang = 'en-US';
    const evan = voices.find(v => v.name.includes('Evan') && v.lang.startsWith('en'));
    const usVoice = evan || voices.find(v => v.lang.startsWith('en-US')) || voices[0];
    if (usVoice) utt.voice = usVoice;

    utt.onboundary = (e) => {
      if (e.name === 'word' && state.sequenceId === seqId) {
        if (segments) {
          const segment = [...segments].reverse().find(s => s.start <= e.charIndex);
          if (!segment) return;
          if (state.currentIndex !== segment.index) {
            state.currentIndex = segment.index;
            highlightSentenceOnPage(segment.index);
            updatePillUI();
          }
          highlightWordAt(segment.offset + e.charIndex - segment.start);
        } else highlightWordAt(offset + e.charIndex);
      }
    };

    utt.onend = () => {
      if (state.sequenceId !== seqId) return;
      if (segments) state.currentIndex = segments.at(-1).index;
      onSentenceFinished();
    };

    utt.onerror = () => {
      if (state.sequenceId !== seqId) return;
      stopReading();
      alert("Speech could not start. Check installed macOS voices or choose Neural audio mode.");
    };

    state.currentSpeechUtterance = utt;
    window.speechSynthesis.speak(utt);
  }

  function onSentenceFinished() {
    if (!state.isPlaying) return;
    if (state.currentIndex + 1 < state.sentences.length) {
      const nextIndex = state.currentIndex + 1;
      const seqId = state.sequenceId;
      const finishedText = (state.sentences[state.currentIndex]?.text || '').trim();
      const isBulletOrHeadingClause = finishedText.length > 0 && !/[.!?…׃'"”’)\]}]$/u.test(finishedText);
      const basePauseMs = isBulletOrHeadingClause ? 190 : 30;
      const pauseMs = Math.max(15, Math.round(basePauseMs / Math.max(0.6, state.speed || 1.0)));
      if (typeof setTimeout !== 'undefined') {
        if (typeof clearTimeout !== 'undefined' && state.sentenceTransitionTimer) {
          clearTimeout(state.sentenceTransitionTimer);
        }
        state.sentenceTransitionTimer = setTimeout(() => {
          state.sentenceTransitionTimer = null;
          if (!state.isPlaying || state.isPaused || seqId !== state.sequenceId) return;
          playSentence(nextIndex, true);
        }, pauseMs);
      } else {
        playSentence(nextIndex, true);
      }
    } else {
      stopReading();
    }
  }

  // 6. Floating Player UI Component
  function createFloatingPill() {
    if (document.getElementById('guy-reader-floating-pill')) return;

    const pill = document.createElement('div');
    pill.id = 'guy-reader-floating-pill';
    pill.innerHTML = `
      <div id="guy-reader-drag-handle" title="Drag to move">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
          <circle cx="5" cy="4" r="1.4"/><circle cx="11" cy="4" r="1.4"/>
          <circle cx="5" cy="8" r="1.4"/><circle cx="11" cy="8" r="1.4"/>
          <circle cx="5" cy="12" r="1.4"/><circle cx="11" cy="12" r="1.4"/>
        </svg>
      </div>
      <span class="guy-reader-status-dot"></span>
      <button class="guy-reader-pill-btn guy-reader-pill-btn-play" id="guy-btn-play" title="Play / Pause (Space)">
        <span id="guy-icon-play">▶</span>
        <span id="guy-icon-pause" style="display:none;">⏸</span>
      </button>
      <button class="guy-reader-pill-btn" id="guy-btn-stop" title="Stop reading">■</button>
      <span class="guy-reader-counter" id="guy-counter">[0/0]</span>
      <div class="guy-reader-speed-group">
        <button class="guy-reader-speed-btn" id="guy-speed-down">−</button>
        <span class="guy-reader-speed-val" id="guy-speed-val">${state.speed.toFixed(1)}x</span>
        <button class="guy-reader-speed-btn" id="guy-speed-up">+</button>
      </div>
      <select class="guy-reader-voice-select" id="guy-mode-select" title="Word highlighting mode" style="display:none;">
        <option value="sync">Follow words · Evan (English)</option>
        <option value="neural">Neural · estimated words</option>
      </select>
      <select class="guy-reader-voice-select" id="guy-voice-select" title="Voice">
        <optgroup label="OpenAI / Codex-Style &amp; Kokoro Neural (Local)">
          <option value="af_heart">🧠 Heart (Expressive)</option>
          <option value="af_nova">🧠 Nova (OpenAI-Style)</option>
          <option value="af_alloy">🧠 Alloy (OpenAI-Style)</option>
          <option value="af_sky">🧠 Sky (OpenAI-Style)</option>
          <option value="af_bella">🧠 Bella</option>
          <option value="af_sarah">🧠 Sarah</option>
          <option value="am_onyx">🧠 Onyx (OpenAI-Style)</option>
          <option value="am_echo">🧠 Echo (OpenAI-Style)</option>
          <option value="am_puck">🧠 Puck</option>
          <option value="am_fenrir">🧠 Fenrir</option>
          <option value="am_adam">🧠 Adam</option>
          <option value="am_liam">🧠 Liam</option>
          <option value="am_michael">🧠 Michael</option>
          <option value="bm_fable">🧠 Fable (British)</option>
          <option value="bm_george">🧠 George (British)</option>
          <option value="bf_emma">🧠 Emma (British)</option>
        </optgroup>
        <optgroup label="Hebrew Neural Voices">
          <option value="edge-he-avri">🌟 Avri (Hebrew Male)</option>
          <option value="edge-he-hila">🌟 Hila (Hebrew Female)</option>
          <option value="edge-he-andrew">🌟 Andrew (HE/EN Male)</option>
          <option value="edge-he-ava">🌟 Ava (HE/EN Female)</option>
          <option value="edge-he-brian">🌟 Brian (HE/EN Male)</option>
          <option value="edge-he-emma">🌟 Emma (HE/EN Female)</option>
        </optgroup>
        <optgroup label="English Edge Neural">
          <option value="edge-en-ava">🌟 Ava (US Female)</option>
          <option value="edge-en-andrew">🌟 Andrew (US Male)</option>
          <option value="edge-en-brian">🌟 Brian (US Male)</option>
          <option value="edge-en-emma">🌟 Emma (US Female)</option>
          <option value="edge-en-aria">🌟 Aria (US Female)</option>
          <option value="edge-en-christopher">🌟 Christopher (US Male)</option>
          <option value="edge-en-jenny">🌟 Jenny (US Female)</option>
          <option value="edge-en-guy">🌟 Guy (US Male)</option>
          <option value="edge-en-sonia">🌟 Sonia (UK Female)</option>
          <option value="edge-en-ryan">🌟 Ryan (UK Male)</option>
        </optgroup>
        <optgroup label="ElevenLabs Multilingual v2">
          <option value="eleven-rachel">💎 Rachel (ElevenLabs)</option>
          <option value="eleven-adam">💎 Adam (ElevenLabs)</option>
          <option value="eleven-charlie">💎 Charlie (ElevenLabs)</option>
        </optgroup>
      </select>
      <span class="guy-reader-clean-btn" id="guy-btn-clean" title="Toggle Clean Reader Mode">📖</span>
      <span class="guy-reader-close-btn" id="guy-btn-close" title="Close Guy_reader">✕</span>
    `;

    document.body.appendChild(pill);
    state.pillEl = pill;

    // Dragging support
    setupPillDragging(pill);

    // Controls
    document.getElementById('guy-btn-stop').addEventListener('click', stopReading);
    const mode = document.getElementById('guy-mode-select');
    mode.value = state.synchronized ? 'sync' : 'neural';
    mode.addEventListener('change', e => {
      state.synchronized = e.target.value === 'sync';
      chrome.storage?.local.set({ guy_reader_sync: state.synchronized });
      if (state.isPlaying || state.isPaused) playSentence(Math.max(0, state.currentIndex), false, state.wordOffset);
    });
    document.getElementById('guy-btn-play').addEventListener('click', () => {
      getAudioContext();
      if (state.isPlaying) pauseReading();
      else resumeReading();
    });

    document.getElementById('guy-speed-down').addEventListener('click', () => {
      setSpeed(Math.max(0.5, Math.round((state.speed - 0.1) * 10) / 10));
    });

    document.getElementById('guy-speed-up').addEventListener('click', () => {
      setSpeed(Math.min(2.5, Math.round((state.speed + 0.1) * 10) / 10));
    });

    document.getElementById('guy-voice-select').addEventListener('change', (e) => {
      const selected = e.target.value;
      if (selected.startsWith('eleven-') && !state.elevenApiKey) {
        const key = prompt('Enter your free ElevenLabs API Key (from elevenlabs.io):');
        if (key && key.trim()) {
          state.elevenApiKey = key.trim();
          chrome.storage?.local.set({ guy_reader_eleven_key: state.elevenApiKey });
        } else {
          alert('ElevenLabs requires an API key. Reverting to previous voice.');
          e.target.value = state.voice || 'edge-he-avri';
          return;
        }
      }
      state.voice = selected;
      chrome.storage?.local.set({ guy_reader_voice: state.voice });
      if ((state.voice.startsWith('edge-') || state.voice.startsWith('eleven-')) && state.synchronized) {
        state.synchronized = false;
        mode.value = 'neural';
        chrome.storage?.local.set({ guy_reader_sync: false });
      }
      if (state.isPlaying || state.isPaused) {
        playSentence(state.currentIndex >= 0 ? state.currentIndex : 0);
      }
    });

    document.getElementById('guy-btn-clean').addEventListener('click', () => {
      toggleCleanReaderMode();
    });

    document.getElementById('guy-btn-close').addEventListener('click', () => {
      stopReading();
      exitCleanReaderMode();
      state.isActive = false;
      pill.classList.add('guy-hidden');
    });
  }

  function setSpeed(newSpeed) {
    state.speed = Math.max(0.5, Math.min(2.5, Math.round(newSpeed * 10) / 10));
    chrome.storage?.local?.set({ guy_reader_speed: state.speed });
    if (state.audioElement) {
      state.audioElement.defaultPlaybackRate = state.speed;
      state.audioElement.playbackRate = state.speed;
    }
    if (state.activeSourceNode && state.activeSourceNode.playbackRate) {
      state.activeSourceNode.playbackRate.value = state.speed;
    }
    const valEl = document.getElementById('guy-speed-val');
    if (valEl) valEl.textContent = state.speed.toFixed(1) + 'x';
  }

  function showFloatingPill() {
    createFloatingPill();
    if (state.pillEl) state.pillEl.classList.remove('guy-hidden');
  }

  function updatePillUI() {
    const summary = JSON.stringify([state.isPlaying,state.isPaused,state.currentIndex,state.sentences.length]);
    if (summary !== state.lastReportedState) {
      state.lastReportedState = summary;
      try { chrome.runtime.sendMessage({action:'reader-state',playing:state.isPlaying,paused:state.isPaused,
        index:state.currentIndex,total:state.sentences.length}, () => { void chrome.runtime.lastError; }); } catch (_) {}
    }
    const playIcon = document.getElementById('guy-icon-play');
    const pauseIcon = document.getElementById('guy-icon-pause');
    const counterEl = document.getElementById('guy-counter');
    const voiceSelect = document.getElementById('guy-voice-select');

    if (playIcon && pauseIcon) {
      if (state.isPlaying) {
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'inline';
      } else {
        playIcon.style.display = 'inline';
        pauseIcon.style.display = 'none';
      }
    }

    if (counterEl) {
      const current = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
      counterEl.textContent = `[${current}/${state.sentences.length}]`;
    }

    if (voiceSelect) voiceSelect.style.display = '';
    if (voiceSelect && voiceSelect.value !== state.voice) {
      voiceSelect.value = state.voice;
    }
  }

  function setupPillDragging(el) {
    const handle = el.querySelector('#guy-reader-drag-handle');
    if (!handle) return;

    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      function onMouseMove(ev) {
        if (!isDragging) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        el.style.left = `${Math.max(10, Math.min(window.innerWidth - el.offsetWidth - 10, initialLeft + dx))}px`;
        el.style.top = `${Math.max(10, Math.min(window.innerHeight - el.offsetHeight - 10, initialTop + dy))}px`;
        el.style.right = 'auto';
      }

      function onMouseUp() {
        isDragging = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      }

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  // 7. Clean Reader Mode
  function toggleCleanReaderMode() {
    if (state.cleanReaderMode) {
      exitCleanReaderMode();
    } else {
      enterCleanReaderMode();
    }
  }

  function escapeCleanHtml(str) {
    return (str || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderCleanSentenceHtml(text, sentenceIndex) {
    let html = `<span class="guy-clean-sentence" data-guy-sentence="${sentenceIndex}">`;
    const tokens = [...(text || '').matchAll(/\S+|\s+/gu)];
    for (const tok of tokens) {
      if (/^\s+$/u.test(tok[0])) {
        html += tok[0];
      } else {
        html += `<span class="guy-clean-word" data-guy-word="${tok.index}">${escapeCleanHtml(tok[0])}</span>`;
      }
    }
    html += `</span>`;
    return html;
  }

  function enterCleanReaderMode() {
    if (state.cleanReaderMode) return;

    if (!state.sentences || state.sentences.length === 0) {
      state.sentences = extractSelectionData() || extractArticleData();
    }

    // Group sentences into paragraphs while preserving exact global sentence indices
    const paragraphs = [];
    let lastEl = null;
    for (let i = 0; i < state.sentences.length; i++) {
      const item = state.sentences[i];
      if (paragraphs.length === 0 || (item.element && item.element !== lastEl)) {
        paragraphs.push([]);
        lastEl = item.element;
      }
      paragraphs[paragraphs.length - 1].push({ index: i, text: item.text });
    }

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'guy-reader-clean-overlay';
    const titleDir = isHebrew(document.title || '') ? 'rtl' : 'ltr';
    overlay.innerHTML = `
      <div class="guy-reader-clean-content">
        <h1 class="guy-reader-clean-title" dir="${titleDir}">${escapeCleanHtml(document.title || 'Article')}</h1>
        ${paragraphs.map(para => {
          const paraText = para.map(p => p.text).join(' ');
          const dir = isHebrew(paraText) ? 'rtl' : 'ltr';
          return `<p class="guy-reader-clean-para" dir="${dir}">${para.map(p => renderCleanSentenceHtml(p.text, p.index)).join(' ')}</p>`;
        }).join('\n')}
      </div>
    `;

    // Click any word or sentence in Clean Reader Mode to jump right to it
    overlay.addEventListener('click', (e) => {
      const wordEl = e.target.closest?.('[data-guy-word]');
      const sentEl = e.target.closest?.('[data-guy-sentence]');
      if (!sentEl) return;
      const sIdx = Number(sentEl.getAttribute('data-guy-sentence'));
      const wOffset = wordEl ? Number(wordEl.getAttribute('data-guy-word')) : 0;
      if (Number.isFinite(sIdx) && sIdx >= 0 && sIdx < state.sentences.length) {
        e.stopPropagation();
        playSentence(sIdx, false, Number.isFinite(wOffset) ? wOffset : 0);
      }
    });

    document.body.appendChild(overlay);
    state.cleanReaderMode = true;

    // Update button state
    const btn = document.getElementById('guy-btn-clean');
    if (btn) {
      btn.title = 'Exit Clean Reader Mode';
      btn.classList.add('guy-clean-active');
    }

    if (state.currentIndex >= 0) {
      highlightSentenceOnPage(state.currentIndex);
      if (state.wordOffset >= 0) {
        highlightWordAt(state.wordOffset);
      }
    }
  }

  function exitCleanReaderMode() {
    if (!state.cleanReaderMode) return;
    const overlay = document.getElementById('guy-reader-clean-overlay');
    if (overlay) overlay.remove();
    state.cleanReaderMode = false;

    const btn = document.getElementById('guy-btn-clean');
    if (btn) {
      btn.title = 'Toggle Clean Reader Mode';
      btn.classList.remove('guy-clean-active');
    }

    if (state.isActive && state.currentIndex >= 0) {
      highlightSentenceOnPage(state.currentIndex);
      if (state.wordOffset >= 0) {
        highlightWordAt(state.wordOffset);
      }
    }
  }

  // 8. Message Router from Background or Popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.expiresAt && Date.now() > msg.expiresAt) {
      sendResponse({success:false, expired:true});
      return false;
    }
    if (msg.voice && msg.voice !== state.voice) {
      state.voice = msg.voice;
      chrome.storage?.local.set({ guy_reader_voice: state.voice });
      const voiceSelect = dom.pill?.querySelector('.pill-voice-select');
      if (voiceSelect) voiceSelect.value = state.voice;
    }
    if (msg.action === 'pause') {
      pauseReading(); sendResponse({success:true});
    } else if (msg.action === 'resume') {
      resumeReading(); sendResponse({success:true});
    } else if (msg.action === 'set-voice') {
      sendResponse({ success: true, voice: state.voice });
    } else if (msg.action === 'toggle-read') {
      const selected = window.getSelection ? window.getSelection().toString().trim() : '';
      const current = state.sentences[state.currentIndex]?.text || '';
      if (selected && !current.includes(selected)) {
        startReading(true);
      } else if (state.isPlaying) {
        pauseReading();
      } else if (state.isPaused) {
        resumeReading();
      } else {
        startReading(true);
      }
      sendResponse({ success: true, isPlaying: state.isPlaying });
    } else if (msg.action === 'read-from-start') {
      startReading(false);
      sendResponse({ success: state.isPlaying });
    } else if (msg.action === 'read-from-selection') {
      startReading(true, msg.text);
      sendResponse({ success: state.isPlaying });
    } else if (msg.action === 'extract-clicked-text') {
      const text = extractClickedOrSelectedText();
      sendResponse({ success: Boolean(text && text.length > 0), text: text || '' });
    } else if (msg.action === 'toggle-pill') {
      showFloatingPill();
      sendResponse({ success: true });
    } else if (msg.action === 'stop') {
      stopReading();
      sendResponse({ success: true });
    }
  });

  // Setup click to seek and selection handlers on start
  setupClickToSeek();
  setupSelectionHandlers();
})();
