import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import * as cheerio from "cheerio";

// ES module dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Handle favicon requests
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Health check endpoint
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Serve screenshots statically
app.use('/screenshots', express.static('screenshots'));

// Serve frontend static files (for production deployment)
app.use(express.static(path.join(__dirname, '../frontend')));

const upload = multer({ dest: "uploads/" });

// ---------------------------------------------------------
// CLEAN NORMALIZE
// ---------------------------------------------------------
const normalize = (text = "") =>
  text
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .replace(/[\(\[].*?[\)\]]/g, "")
    .toLowerCase()
    .trim();

// ---------------------------------------------------------
// SIMILARITY SCORE (word-based, bidirectional F1)
// ---------------------------------------------------------
const getSimilarityScore = (textA, textB) => {
  const wordsA = normalize(textA).split(" ").filter(Boolean);
  const wordsB = normalize(textB).split(" ").filter(Boolean);
  if (!wordsA.length) return { score: 0, matchedWords: [], unmatchedWords: wordsA, extraWords: [], totalWords: 0 };

  const matchedWords = [];
  const unmatchedWords = [];

  wordsA.forEach(word => {
    if (wordsB.includes(word)) {
      matchedWords.push(word);
    } else {
      unmatchedWords.push(word);
    }
  });

  // Words in B that are NOT in A (extra content)
  const wordsASet = new Set(wordsA.map(w => w.toLowerCase()));
  const extraWords = wordsB.filter(w => !wordsASet.has(w.toLowerCase()));

  // Precision: of doc words, how many found in email?
  const precision = wordsA.length > 0 ? matchedWords.length / wordsA.length : 0;
  // Recall: of email words, how many came from doc? (penalizes extra content)
  const recall = wordsB.length > 0 ? matchedWords.length / wordsB.length : 0;
  // F1 score: harmonic mean — balances both directions
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    score: f1,
    precision,
    recall,
    matchedWords,
    unmatchedWords,    // doc words NOT in email
    extraWords,        // email words NOT in doc
    totalWords: wordsA.length,
    totalEmailWords: wordsB.length
  };
};

// ---------------------------------------------------------
// UTM HELPERS
// ---------------------------------------------------------
const stripUtm = (href = "") => {
  try {
    const url = new URL(href);
    url.searchParams.forEach((_, key) => {
      if (key.toLowerCase().startsWith("utm")) url.searchParams.delete(key);
    });
    return url.origin + url.pathname;
  } catch {
    return href.split("?")[0].trim();
  }
};
const hasUtm = (href) => /utm[_=-]/i.test(href);

// ---------------------------------------------------------
// RETRY HELPER — retries failed network requests with backoff
// ---------------------------------------------------------
async function withRetry(fn, { retries = 3, baseDelay = 2000, label = 'request' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable = error.code === 'ECONNRESET' ||
        error.code === 'ECONNABORTED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'EAI_AGAIN' ||
        error.message?.includes('timeout') ||
        error.message?.includes('socket hang up') ||
        (error.response && error.response.status >= 500);

      if (!isRetryable || attempt === retries) {
        console.error(`${label} failed after ${attempt} attempt(s): ${error.message}`);
        throw error;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1); // exponential backoff
      console.warn(`${label} attempt ${attempt} failed (${error.message}). Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------
// SCRAPE EMAIL (using axios + cheerio - NO BROWSER NEEDED!)
// Handles 302 redirect chains with cookie forwarding
// Now with retry logic for intermittent failures
// ---------------------------------------------------------
async function getEmailContent(url) {
  return withRetry(async () => {
    return await _fetchEmailContent(url);
  }, { retries: 3, baseDelay: 2000, label: 'Email fetch' });
}

async function _fetchEmailContent(url) {
  try {
    let currentUrl = url;
    let cookies = [];
    let response;
    const MAX_REDIRECTS = 10;

    // Manually follow redirects to preserve cookies across hops
    for (let i = 0; i < MAX_REDIRECTS; i++) {
      console.log(`Fetching (redirect hop ${i + 1}): ${currentUrl}`);
      response = await axios.get(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          ...(cookies.length > 0 ? { 'Cookie': cookies.join('; ') } : {}),
        },
        timeout: 45000,               // increased timeout for slow servers
        maxRedirects: 0,              // disable auto-redirects
        validateStatus: (s) => s < 400, // accept 2xx and 3xx
      });

      // Collect any Set-Cookie headers
      const setCookies = response.headers['set-cookie'];
      if (setCookies) {
        setCookies.forEach(c => {
          const cookiePair = c.split(';')[0]; // take "name=value" part
          cookies.push(cookiePair);
        });
      }

      // If it's a redirect, follow the Location header
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        let nextUrl = response.headers['location'];

        // If no Location header, check for JS-based redirect in body
        if (!nextUrl && typeof response.data === 'string') {
          console.log('No Location header — checking response body for JS redirect...');
          const body = response.data;

          // Pattern 1: var redirecturl = '...';
          const jsRedirectMatch = body.match(/var\s+redirecturl\s*=\s*['"]([^'"]+)['"]/i);
          // Pattern 2: window.location = '...' or window.location.href = '...'
          const winLocMatch = body.match(/window\.(?:self\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
          // Pattern 3: window.location.replace('...')
          const winReplaceMatch = body.match(/window\.location\.replace\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
          // Pattern 4: <meta http-equiv="refresh" content="0;url=...">
          const metaRefreshMatch = body.match(/<meta[^>]*http-equiv\s*=\s*['"]refresh['"][^>]*content\s*=\s*['"][^'"]*url\s*=\s*([^'">\s]+)/i);

          nextUrl = (jsRedirectMatch && jsRedirectMatch[1]) ||
            (winLocMatch && winLocMatch[1]) ||
            (winReplaceMatch && winReplaceMatch[1]) ||
            (metaRefreshMatch && metaRefreshMatch[1]) ||
            null;

          if (nextUrl) {
            console.log(`Found JS/meta redirect URL in response body`);
          }
        }

        if (!nextUrl) {
          console.warn('Redirect with no Location header and no JS redirect found, stopping.');
          break;
        }
        // Resolve relative URLs  
        try {
          currentUrl = new URL(nextUrl, currentUrl).href;
        } catch {
          currentUrl = nextUrl;
        }
        console.log(`Redirected (${response.status}) → ${currentUrl}`);
        continue;
      }

      // Got a 2xx — we have the final page
      break;
    }

    const html = response.data;
    const $ = cheerio.load(html);

    // Remove script and style elements
    $('script, style, noscript').remove();

    // Extract text content (flat, for backward compat)
    const text = $('body').text()
      .replace(/\s+/g, ' ')
      .trim();

    // Extract paragraph-level text blocks from the email HTML
    // This preserves paragraph boundaries for accurate comparison
    const paragraphs = [];
    const blockSelectors = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, caption';
    $(blockSelectors).each((_, el) => {
      // Skip if this element contains other block elements (avoid double-counting)
      if ($(el).find(blockSelectors).length > 0 && el.tagName.toLowerCase() === 'td') {
        return; // skip table cells that contain paragraphs
      }
      const txt = $(el).text().replace(/\s+/g, ' ').trim();
      if (txt.length > 10) {
        paragraphs.push(txt);
      }
    });

    // Deduplicate paragraphs (some content may appear in nested elements)
    const emailParagraphs = [];
    paragraphs.forEach(p => {
      // Only add if not a substring of an already-added paragraph
      const isDuplicate = emailParagraphs.some(existing =>
        existing.includes(p) || p.includes(existing)
      );
      if (!isDuplicate) {
        emailParagraphs.push(p);
      } else {
        // If this is longer than an existing one it contains, replace it
        const shorterIdx = emailParagraphs.findIndex(existing => p.includes(existing) && p.length > existing.length);
        if (shorterIdx !== -1) {
          emailParagraphs[shorterIdx] = p;
        }
      }
    });

    console.log(`Extracted ${emailParagraphs.length} paragraphs from email`);

    // Extract links
    const links = [];
    $('a').each((_, element) => {
      const href = $(element).attr('href') || '';
      const linkText = $(element).text().trim();
      if (href) {
        links.push({ text: linkText, href: href });
      }
    });

    // Extract images (distinguish missing alt vs empty alt)
    const images = [];
    $('img').each((_, element) => {
      const src = $(element).attr('src') || '';
      const hasAltAttr = element.attribs && 'alt' in element.attribs;
      const alt = hasAltAttr ? $(element).attr('alt') : undefined;
      if (src) {
        images.push({ src, alt });
      }
    });

    console.log(`Successfully extracted: ${text.length} chars, ${links.length} links, ${images.length} images`);
    return { text, html, links, images, emailParagraphs, resolvedUrl: currentUrl };
  } catch (error) {
    console.error("Error fetching email content:", error.message);
    if (error.response) {
      console.error(`Response status: ${error.response.status}`);
      console.error(`Response headers:`, JSON.stringify(error.response.headers, null, 2));
    }
    throw new Error(`Failed to fetch email content: ${error.message}`);
  }
}


// ---------------------------------------------------------
// DOCX TEXT + LINKS
// ---------------------------------------------------------
async function extractDoc(filePath) {
  const rawText = (await mammoth.extractRawText({ path: filePath })).value || "";
  const html = (await mammoth.convertToHtml({ path: filePath })).value || "";

  const links = [];
  const anchorRegex = /<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    links.push({ text: match[2].trim(), href: match[1].trim() });
  }

  // RAW URLs
  new Set(rawText.match(/https?:\/\/[^\s"')]+/gi) || []).forEach((u) =>
    links.push({ text: u, href: u })
  );

  return { docText: rawText, docLinks: links };
}

// ---------------------------------------------------------
// FIND BEST EMAIL SEGMENT for a doc block
// Matches against actual email paragraphs for clean segments
// ---------------------------------------------------------
function findBestEmailSegment(docBlock, emailParagraphs, emailTextFlat) {
  if (!docBlock) return { segment: '', score: 0, precision: 0, recall: 0 };

  let bestSegment = '';
  let bestScore = 0;
  let bestPrecision = 0;
  let bestRecall = 0;

  // Strategy 1: Match against individual email paragraphs
  if (emailParagraphs && emailParagraphs.length > 0) {
    emailParagraphs.forEach(para => {
      const result = getSimilarityScore(docBlock, para);
      if (result.score > bestScore) {
        bestScore = result.score;
        bestSegment = para;
        bestPrecision = result.precision;
        bestRecall = result.recall;
      }
    });

    // Also try combining consecutive paragraphs (2-3) for multi-paragraph doc blocks
    for (let i = 0; i < emailParagraphs.length - 1; i++) {
      const combined2 = emailParagraphs[i] + ' ' + emailParagraphs[i + 1];
      const result2 = getSimilarityScore(docBlock, combined2);
      if (result2.score > bestScore) {
        bestScore = result2.score;
        bestSegment = combined2;
        bestPrecision = result2.precision;
        bestRecall = result2.recall;
      }

      if (i < emailParagraphs.length - 2) {
        const combined3 = combined2 + ' ' + emailParagraphs[i + 2];
        const result3 = getSimilarityScore(docBlock, combined3);
        if (result3.score > bestScore) {
          bestScore = result3.score;
          bestSegment = combined3;
          bestPrecision = result3.precision;
          bestRecall = result3.recall;
        }
      }
    }
  }

  // Strategy 2: If no good paragraph match and we have flat text, use it as fallback
  if (bestScore < 0.4 && emailTextFlat) {
    const flatResult = getSimilarityScore(docBlock, emailTextFlat);
    if (flatResult.precision > 0.5) {
      // Content exists somewhere in email but wasn't in a clean paragraph
      // Extract a rough context
      const docWords = normalize(docBlock).split(' ').filter(Boolean);
      const emailLower = emailTextFlat.toLowerCase();
      // Find a distinctive word from the doc
      const longWords = docWords.filter(w => w.length > 5).slice(0, 3);
      for (const word of longWords) {
        const idx = emailLower.indexOf(word);
        if (idx !== -1) {
          const start = Math.max(0, emailTextFlat.lastIndexOf(' ', Math.max(0, idx - 20)));
          const end = Math.min(emailTextFlat.length, emailTextFlat.indexOf(' ', idx + docBlock.length + 20) || emailTextFlat.length);
          const context = emailTextFlat.substring(start, end).trim();
          const ctxResult = getSimilarityScore(docBlock, context);
          if (ctxResult.score > bestScore) {
            bestScore = ctxResult.score;
            bestSegment = (start > 0 ? '...' : '') + context + (end < emailTextFlat.length ? '...' : '');
            bestPrecision = ctxResult.precision;
            bestRecall = ctxResult.recall;
          }
          break;
        }
      }
    }
  }

  return {
    segment: bestSegment,
    score: bestScore,
    precision: bestPrecision,
    recall: bestRecall
  };
}

// ---------------------------------------------------------
// DETAILED TEXT COMPARISON (side-by-side: doc vs email)
// ---------------------------------------------------------
const compareTextDetailed = (docText, emailText, emailParagraphs, threshold = 0.7) => {
  // Split document into meaningful blocks (paragraphs/sentences)
  const docBlocks = docText
    .split(/\n{1,2}/)
    .map((t) => t.trim())
    .filter((t) => t.length > 10);

  const results = {
    matched: [],
    partialMatch: [],
    notFound: [],
    metadata: []
  };

  docBlocks.forEach((block) => {
    const lower = block.toLowerCase();

    // Check if it's metadata (subject, preheader)
    if (lower.includes("subject:") || lower.includes("preheader:") ||
      lower.startsWith("subject") || lower.startsWith("preheader")) {
      results.metadata.push({
        type: lower.includes("subject") ? "Subject Line" : "Preheader",
        content: block,
        note: "Not expected in email body (metadata only)"
      });
      return;
    }

    // Find the best matching email segment using paragraph matching
    const { segment: emailSegment, score: segmentScore, precision, recall } = findBestEmailSegment(block, emailParagraphs, emailText);
    const percentage = Math.round(segmentScore * 100);

    // Get word-level details
    const { matchedWords, unmatchedWords, extraWords, totalWords, totalEmailWords } = getSimilarityScore(block, emailSegment);

    const blockResult = {
      originalText: block,              // Expected (from doc)
      emailText: emailSegment,          // Actual (from email)
      matchPercentage: percentage,       // F1 score against the segment
      precision: Math.round((precision || 0) * 100),  // % of doc words found
      recall: Math.round((recall || 0) * 100),        // % of email segment from doc
      matchedWords: matchedWords.slice(0, 15),
      unmatchedWords: unmatchedWords.slice(0, 15),
      extraWords: (extraWords || []).slice(0, 10),
      totalWords: totalWords,
      totalEmailWords: totalEmailWords || 0
    };

    if (segmentScore >= 0.9) {
      blockResult.status = "FULL MATCH";
      results.matched.push(blockResult);
    } else if (segmentScore >= threshold) {
      blockResult.status = "PARTIAL MATCH";
      results.partialMatch.push(blockResult);
    } else {
      blockResult.status = "NOT FOUND";
      results.notFound.push(blockResult);
    }
  });

  // Calculate overall statistics
  const totalBlocks = results.matched.length + results.partialMatch.length + results.notFound.length;
  const overallScore = totalBlocks > 0
    ? Math.round(((results.matched.length + results.partialMatch.length * 0.5) / totalBlocks) * 100)
    : 100;

  return {
    ...results,
    summary: {
      totalBlocks,
      fullMatches: results.matched.length,
      partialMatches: results.partialMatch.length,
      notFound: results.notFound.length,
      metadataItems: results.metadata.length,
      overallScore
    }
  };
};

// ---------------------------------------------------------
// LINK CHECK
// ---------------------------------------------------------
const compareLinks = (docLinks, emailLinks) => {
  const emailMap = emailLinks.map((l) => stripUtm(l.href));
  const missing = [];
  const report = [];

  docLinks.forEach((dl) => {
    const docStripped = stripUtm(dl.href);
    const found = emailMap.includes(docStripped);

    report.push({
      text: dl.text,
      docHref: dl.href,
      foundInEmail: found ? "YES" : "NO",
      utmInDoc: hasUtm(dl.href) ? "YES" : "NO",
    });

    if (!found) missing.push(dl);
  });

  return { report, missing };
};

// ---------------------------------------------------------
// IMAGE ALT TAG CHECK
// ---------------------------------------------------------
function checkImageAltTags(images) {
  const results = [];
  let missingCount = 0;
  let emptyCount = 0;
  let genericCount = 0;
  let validCount = 0;

  // Common generic/placeholder alt text patterns
  const genericPatterns = [
    /^image$/i,
    /^img$/i,
    /^photo$/i,
    /^picture$/i,
    /^banner$/i,
    /^logo$/i,
    /^icon$/i,
    /^spacer$/i,
    /^pixel$/i,
    /^untitled$/i,
    /^\d+$/,
    /^image\s*\d+$/i,
    /^img\s*\d+$/i,
    /^dsc\d+$/i,
    /^screenshot/i,
    /^\.\w+$/,           // just a file extension like ".jpg"
    /^https?:\/\//i,     // URL used as alt text
  ];

  // Image src patterns that are decorative/tracking pixels
  const decorativePatterns = [
    /spacer/i,
    /pixel/i,
    /tracking/i,
    /blank\.gif/i,
    /1x1/i,
    /transparent/i,
    /shim/i,
  ];

  images.forEach((img, index) => {
    const src = img.src || '';
    const alt = (img.alt || '').trim();

    // Check if it's likely a decorative/tracking pixel
    const isDecorative = decorativePatterns.some(p => p.test(src)) ||
      (src.includes('width=1') && src.includes('height=1'));

    let status, severity, message;

    if (!img.alt && img.alt !== '') {
      // alt attribute is completely missing from the <img> tag
      status = 'MISSING';
      severity = isDecorative ? 'low' : 'high';
      message = isDecorative
        ? 'Alt attribute missing (likely decorative/tracking pixel)'
        : 'Alt attribute is completely missing — accessibility issue';
      missingCount++;
    } else if (alt === '') {
      // alt="" (empty) — acceptable for decorative images
      if (isDecorative) {
        status = 'OK';
        severity = 'none';
        message = 'Empty alt text (decorative image — acceptable)';
        validCount++;
      } else {
        status = 'EMPTY';
        severity = 'medium';
        message = 'Alt text is empty — should have descriptive text unless purely decorative';
        emptyCount++;
      }
    } else if (genericPatterns.some(p => p.test(alt))) {
      // Generic/placeholder alt text
      status = 'GENERIC';
      severity = 'medium';
      message = `Alt text "${alt}" appears generic or auto-generated`;
      genericCount++;
    } else {
      // Has meaningful alt text
      status = 'OK';
      severity = 'none';
      message = 'Has descriptive alt text';
      validCount++;
    }

    // Extract a readable filename from src
    let srcLabel = src;
    try {
      const urlObj = new URL(src);
      srcLabel = urlObj.pathname.split('/').pop() || src;
    } catch {
      srcLabel = src.split('/').pop() || src;
    }
    // Truncate long src labels
    if (srcLabel.length > 60) srcLabel = srcLabel.substring(0, 57) + '...';

    results.push({
      index: index + 1,
      src: src,
      srcLabel,
      alt: img.alt,
      altDisplay: alt || (img.alt === '' ? '(empty)' : '(missing)'),
      status,
      severity,
      message,
      isDecorative,
    });
  });

  const totalImages = images.length;
  const issueCount = missingCount + emptyCount + genericCount;

  return {
    results,
    summary: {
      totalImages,
      missingAlt: missingCount,
      emptyAlt: emptyCount,
      genericAlt: genericCount,
      validAlt: validCount,
      issueCount,
      status: issueCount === 0 ? 'PASS' : (missingCount > 0 ? 'FAIL' : 'WARNING'),
    },
  };
}

// ---------------------------------------------------------
// RESPONSIVE CHECK (using free screenshot API)
// ---------------------------------------------------------
async function checkResponsive(url) {
  // We'll use a simple heuristic based on viewport meta tag
  // and media queries presence
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 20000,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Check for viewport meta tag
    const viewportMeta = $('meta[name="viewport"]').attr('content') || '';
    const hasViewport = viewportMeta.includes('width=device-width') || viewportMeta.includes('initial-scale');

    // Check for responsive patterns in style
    const hasMediaQueries = html.includes('@media') ||
      html.includes('max-width') ||
      html.includes('min-width');

    // Check for responsive table patterns (common in emails)
    const hasResponsiveTables = html.includes('100%') ||
      html.includes('max-width:');

    let responsive = "Unable to determine";
    if (hasViewport && (hasMediaQueries || hasResponsiveTables)) {
      responsive = "YES – Likely responsive (viewport & media queries detected)";
    } else if (hasViewport) {
      responsive = "MAYBE – Has viewport tag but limited responsive CSS";
    } else {
      responsive = "NO – No responsive indicators found";
    }

    return {
      responsive,
      details: {
        hasViewportTag: hasViewport,
        hasMediaQueries,
        hasResponsiveTables,
        viewportContent: viewportMeta || 'Not found'
      }
    };
  } catch (error) {
    console.error("Error checking responsiveness:", error.message);
    return {
      responsive: "Unable to check",
      details: { error: error.message }
    };
  }
}

// ---------------------------------------------------------
// GRAMMAR CHECK (using free LanguageTool public API)
// No API key needed! Supports English grammar, spelling,
// punctuation, and style checks.
// ---------------------------------------------------------
async function checkGrammar(text, label = 'Text') {
  try {
    if (!text || text.trim().length < 20) {
      return { issues: [], summary: { total: 0, status: 'PASS' }, label };
    }

    // LanguageTool free API has a ~20KB text limit; truncate safely
    const cleanText = text
      .replace(/<[^>]+>/g, ' ')   // strip HTML tags
      .replace(/\s+/g, ' ')       // collapse whitespace
      .trim()
      .substring(0, 10000);       // stay well within limits

    console.log(`Grammar check (${label}): sending ${cleanText.length} chars to LanguageTool...`);

    const params = new URLSearchParams();
    params.append('text', cleanText);
    params.append('language', 'en-US');
    params.append('enabledOnly', 'false');

    const response = await axios.post(
      'https://api.languagetool.org/v2/check',
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000,
      }
    );

    const matches = response.data.matches || [];

    // Categorize and format issues
    const issues = matches.map(m => {
      const category = m.rule?.category?.id || 'UNKNOWN';
      const context = m.context || {};
      const contextText = context.text || '';
      const offset = context.offset || 0;
      const length = context.length || 0;
      const errorText = contextText.substring(offset, offset + length);

      // Determine severity
      let severity = 'info';
      let isProperNoun = false;

      if (category === 'TYPOS' || category === 'GRAMMAR') {
        severity = 'high';

        // Downgrade proper nouns / brand names:
        // If the word starts with a capital letter and is flagged as TYPOS,
        // it's likely a company name, person name, or brand (e.g. "Grazitti").
        if (category === 'TYPOS' && errorText && /^[A-Z]/.test(errorText)) {
          severity = 'low';
          isProperNoun = true;
        }
      }
      else if (category === 'PUNCTUATION' || category === 'CASING') severity = 'medium';
      else if (category === 'STYLE' || category === 'REDUNDANCY') severity = 'low';
      else severity = 'medium';

      return {
        message: isProperNoun
          ? `${m.message || 'Issue detected'} (likely a proper noun / brand name)`
          : (m.message || 'Issue detected'),
        shortMessage: m.shortMessage || '',
        category: m.rule?.category?.name || category,
        categoryId: category,
        severity,
        isProperNoun,
        context: contextText,
        errorText,
        offset: m.offset,
        length: m.length,
        replacements: (m.replacements || []).slice(0, 3).map(r => r.value),
        ruleId: m.rule?.id || '',
        ruleDescription: m.rule?.description || '',
      };
    });

    // Summary counts
    const highCount = issues.filter(i => i.severity === 'high').length;
    const mediumCount = issues.filter(i => i.severity === 'medium').length;
    const lowCount = issues.filter(i => i.severity === 'low').length;

    const status = highCount > 0 ? 'FAIL' : mediumCount > 0 ? 'WARNING' : 'PASS';

    console.log(`Grammar check (${label}): ${issues.length} issues found (${highCount} high, ${mediumCount} medium, ${lowCount} low)`);

    return {
      issues,
      summary: {
        total: issues.length,
        high: highCount,
        medium: mediumCount,
        low: lowCount,
        status,
      },
      label,
    };
  } catch (error) {
    console.warn(`Grammar check failed for ${label} (non-fatal): ${error.message}`);
    return {
      issues: [],
      summary: { total: 0, status: 'SKIPPED', error: error.message },
      label,
    };
  }
}

// ---------------------------------------------------------
// FORMAT OUTPUT AS JSON
// ---------------------------------------------------------
function formatResultJSON(data) {
  const hasTextIssues = data.textComparison.summary.notFound.length > 0;
  const hasMissingLinks = data.missingDocLinks.length > 0;
  const hasAltIssues = data.imageAltCheck && data.imageAltCheck.summary.missingAlt > 0;

  return {
    overallStatus: (hasTextIssues || hasMissingLinks || hasAltIssues) ? "FAIL" : "PASS",
    textComparison: {
      summary: data.textComparison.summary,
      details: {
        matched: data.textComparison.matched,
        partialMatch: data.textComparison.partialMatch,
        notFound: data.textComparison.notFound,
        metadata: data.textComparison.metadata
      }
    },
    linkComparison: {
      summary: {
        totalLinks: data.linkReport.length,
        foundInEmail: data.linkReport.filter(l => l.foundInEmail === "YES").length,
        missing: data.missingDocLinks.length
      },
      details: data.linkReport,
      missingLinks: data.missingDocLinks
    },
    imageAltCheck: data.imageAltCheck || { results: [], summary: { totalImages: 0, issueCount: 0, status: 'PASS' } },
    grammarCheck: data.grammarCheck || null,
    emailHtml: data.emailHtml || null,
    emailResolvedUrl: data.emailResolvedUrl || null,
    responsive: data.responsive,
    responsiveDetails: data.responsiveDetails || null
  };
}

// ---------------------------------------------------------
// MAIN ENDPOINT
// ---------------------------------------------------------
app.post("/qa", upload.single("file"), async (req, res) => {
  const file = req.file;
  try {
    const { emailUrl } = req.body;

    if (!emailUrl || !file) {
      return res.status(400).json({ error: "Missing input" });
    }

    console.log(`Processing QA for URL: ${emailUrl}`);
    console.log(`File: ${file.originalname}`);

    const { docText, docLinks } = await extractDoc(file.path);
    console.log(`Extracted ${docLinks.length} links from document`);

    const { text: emailText, html: emailHtml, links: emailLinks, images: emailImages, emailParagraphs, resolvedUrl } = await getEmailContent(emailUrl);
    console.log(`Extracted ${emailLinks.length} links, ${emailImages.length} images, and ${emailParagraphs.length} paragraphs from email`);
    console.log(`Resolved URL: ${resolvedUrl}`);

    // Use new detailed comparison with paragraph-level matching
    const textComparison = compareTextDetailed(docText, emailText, emailParagraphs);

    const { report: linkReport, missing: missingDocLinks } = compareLinks(
      docLinks,
      emailLinks
    );

    // Check image alt tags
    const imageAltCheck = checkImageAltTags(emailImages);
    console.log(`Image alt check: ${imageAltCheck.summary.totalImages} images, ${imageAltCheck.summary.issueCount} issues`);

    // Check responsive design — wrapped so it NEVER crashes the whole QA
    let responsive = "Unable to check";
    let responsiveDetails = null;
    try {
      const responsiveResult = await checkResponsive(resolvedUrl || emailUrl);
      responsive = responsiveResult.responsive;
      responsiveDetails = responsiveResult.details;
    } catch (respErr) {
      console.warn(`Responsive check failed (non-fatal): ${respErr.message}`);
      responsiveDetails = { error: respErr.message, note: "Responsive check failed but comparison results are still valid" };
    }

    // Grammar check — run for both doc and email text (non-fatal)
    let grammarCheck = null;
    try {
      const [docGrammar, emailGrammar] = await Promise.all([
        checkGrammar(docText, 'Document'),
        checkGrammar(emailText, 'Email'),
      ]);
      grammarCheck = {
        document: docGrammar,
        email: emailGrammar,
        totalIssues: docGrammar.summary.total + emailGrammar.summary.total,
      };
      console.log(`Grammar check complete: ${grammarCheck.totalIssues} total issues`);
    } catch (grammarErr) {
      console.warn(`Grammar check failed (non-fatal): ${grammarErr.message}`);
      grammarCheck = null;
    }

    // Return JSON response
    const result = formatResultJSON({
      textComparison,
      linkReport,
      missingDocLinks,
      imageAltCheck,
      grammarCheck,
      emailHtml,
      emailResolvedUrl: resolvedUrl,
      responsive,
      responsiveDetails
    });

    console.log(`QA completed. Overall status: ${result.overallStatus}`);
    res.json(result);
  } catch (err) {
    console.error("QA Processing Error:", err.message);
    console.error("Stack trace:", err.stack);
    res.status(500).json({ error: "QA processing failed", details: err.message });
  } finally {
    // Always clean up uploaded file, even on error
    if (file && file.path) {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
          console.log('Cleaned up uploaded file.');
        }
      } catch (cleanupErr) {
        console.warn(`File cleanup failed: ${cleanupErr.message}`);
      }
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 QA Server running on port ${PORT}`));
