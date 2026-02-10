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
// SIMILARITY SCORE (word-based)
// ---------------------------------------------------------
const getSimilarityScore = (docBlock, emailText) => {
  const docWords = normalize(docBlock).split(" ").filter(Boolean);
  const emailWords = normalize(emailText).split(" ").filter(Boolean);
  if (!docWords.length) return { score: 0, matchedWords: [], unmatchedWords: docWords };

  const matchedWords = [];
  const unmatchedWords = [];

  docWords.forEach(word => {
    if (emailWords.includes(word)) {
      matchedWords.push(word);
    } else {
      unmatchedWords.push(word);
    }
  });

  const score = matchedWords.length / docWords.length;
  return { score, matchedWords, unmatchedWords, totalWords: docWords.length };
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
// SCRAPE EMAIL (using axios + cheerio - NO BROWSER NEEDED!)
// Handles 302 redirect chains with cookie forwarding
// ---------------------------------------------------------
async function getEmailContent(url) {
  try {
    let currentUrl = url;
    let cookies = [];
    let response;
    const MAX_REDIRECTS = 10;

    // Manually follow redirects to preserve cookies across hops
    for (let i = 0; i < MAX_REDIRECTS; i++) {
      console.log(`Fetching (attempt ${i + 1}): ${currentUrl}`);
      response = await axios.get(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          ...(cookies.length > 0 ? { 'Cookie': cookies.join('; ') } : {}),
        },
        timeout: 30000,
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

    // Extract text content
    const text = $('body').text()
      .replace(/\s+/g, ' ')
      .trim();

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
    return { text, links, images, resolvedUrl: currentUrl };
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
// DETAILED TEXT COMPARISON (side-by-side: doc vs email)
// ---------------------------------------------------------
const compareTextDetailed = (docText, emailText, threshold = 0.7) => {
  // Split document into meaningful blocks (paragraphs/sentences)
  const docBlocks = docText
    .split(/\n{1,2}/)
    .map((t) => t.trim())
    .filter((t) => t.length > 10); // Filter out very short blocks

  // Split email text into comparable blocks for best-match finding
  // Use sentence-like splitting since email text is flattened
  const emailSentences = emailText
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|(?<=\b(?:Read More|Learn More|Register Now|Sign Up|Get Started|Download|View|Click Here|Contact Us|Shop Now|Buy Now|Subscribe|Join|Explore))\s+/i)
    .map(s => s.trim())
    .filter(s => s.length > 5);

  // Also create overlapping windows of email text for better matching
  const emailWindows = [];
  const words = emailText.replace(/\s+/g, ' ').split(' ');
  // Create windows of varying sizes (10, 20, 40, 60 words)
  [10, 20, 40, 60].forEach(windowSize => {
    for (let i = 0; i <= words.length - windowSize; i += Math.floor(windowSize / 3)) {
      emailWindows.push(words.slice(i, i + windowSize).join(' '));
    }
  });

  // Combine sentences and windows for matching
  const emailCandidates = [...emailSentences, ...emailWindows];

  const results = {
    matched: [],
    partialMatch: [],
    notFound: [],
    metadata: [] // subject, preheader, etc.
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

    // Score against full email text (for overall match %)
    const { score, matchedWords, unmatchedWords, totalWords } = getSimilarityScore(block, emailText);
    const percentage = Math.round(score * 100);

    // Find the best matching email block/segment
    let bestEmailMatch = '';
    let bestEmailScore = 0;

    emailCandidates.forEach(candidate => {
      const candidateScore = getSimilarityScore(block, candidate).score;
      // Also check reverse: how well does the candidate match the block
      const reverseScore = getSimilarityScore(candidate, block).score;
      // Use average of both directions for better matching
      const avgScore = (candidateScore + reverseScore) / 2;

      if (avgScore > bestEmailScore) {
        bestEmailScore = avgScore;
        bestEmailMatch = candidate;
      }
    });

    // If no good candidate found, try to extract a surrounding context from email
    if (bestEmailScore < 0.3 && matchedWords.length > 0) {
      // Find where the first matched word appears in email and extract context
      const emailLower = emailText.toLowerCase();
      const firstMatch = matchedWords[0];
      const idx = emailLower.indexOf(firstMatch.toLowerCase());
      if (idx !== -1) {
        const start = Math.max(0, idx - 100);
        const end = Math.min(emailText.length, idx + block.length + 100);
        bestEmailMatch = (start > 0 ? '...' : '') + emailText.substring(start, end).trim() + (end < emailText.length ? '...' : '');
      }
    }

    const blockResult = {
      originalText: block,           // Expected (from doc)
      emailText: bestEmailMatch,     // Actual (from email)  
      emailMatchScore: Math.round(bestEmailScore * 100),
      matchPercentage: percentage,
      matchedWords: matchedWords.slice(0, 15), // Increased limit
      unmatchedWords: unmatchedWords.slice(0, 15),
      totalWords: totalWords
    };

    if (score >= 0.9) {
      blockResult.status = "FULL MATCH";
      results.matched.push(blockResult);
    } else if (score >= threshold) {
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
      timeout: 15000,
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
    responsive: data.responsive,
    responsiveDetails: data.responsiveDetails || null
  };
}

// ---------------------------------------------------------
// MAIN ENDPOINT
// ---------------------------------------------------------
app.post("/qa", upload.single("file"), async (req, res) => {
  try {
    const { emailUrl } = req.body;
    const file = req.file;

    if (!emailUrl || !file) {
      return res.status(400).json({ error: "Missing input" });
    }

    console.log(`Processing QA for URL: ${emailUrl}`);
    console.log(`File: ${file.originalname}`);

    const { docText, docLinks } = await extractDoc(file.path);
    console.log(`Extracted ${docLinks.length} links from document`);

    const { text: emailText, links: emailLinks, images: emailImages, resolvedUrl } = await getEmailContent(emailUrl);
    console.log(`Extracted ${emailLinks.length} links and ${emailImages.length} images from email`);
    console.log(`Resolved URL: ${resolvedUrl}`);

    // Use new detailed comparison
    const textComparison = compareTextDetailed(docText, emailText);

    const { report: linkReport, missing: missingDocLinks } = compareLinks(
      docLinks,
      emailLinks
    );

    // Check image alt tags
    const imageAltCheck = checkImageAltTags(emailImages);
    console.log(`Image alt check: ${imageAltCheck.summary.totalImages} images, ${imageAltCheck.summary.issueCount} issues`);

    // Check responsive design (use resolved URL to avoid 302 issues)
    const { responsive, details: responsiveDetails } = await checkResponsive(resolvedUrl || emailUrl);

    // Clean up uploaded file
    fs.unlinkSync(file.path);

    // Return JSON response
    const result = formatResultJSON({
      textComparison,
      linkReport,
      missingDocLinks,
      imageAltCheck,
      responsive,
      responsiveDetails
    });

    console.log(`QA completed. Overall status: ${result.overallStatus}`);
    res.json(result);
  } catch (err) {
    console.error("QA Processing Error:", err.message);
    console.error("Stack trace:", err.stack);
    res.status(500).json({ error: "QA processing failed", details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 QA Server running on port ${PORT}`));
