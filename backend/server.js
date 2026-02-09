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
// ---------------------------------------------------------
async function getEmailContent(url) {
  try {
    // Fetch the HTML using axios
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 30000,
      maxRedirects: 5,
    });

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

    // Extract images
    const images = [];
    $('img').each((_, element) => {
      const src = $(element).attr('src') || '';
      const alt = $(element).attr('alt') || '';
      if (src) {
        images.push({ src, alt });
      }
    });

    return { text, links, images };
  } catch (error) {
    console.error("Error fetching email content:", error.message);
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
// DETAILED TEXT COMPARISON
// ---------------------------------------------------------
const compareTextDetailed = (docText, emailText, threshold = 0.7) => {
  // Split document into meaningful blocks (paragraphs/sentences)
  const blocks = docText
    .split(/\n{1,2}/)
    .map((t) => t.trim())
    .filter((t) => t.length > 10); // Filter out very short blocks

  const results = {
    matched: [],
    partialMatch: [],
    notFound: [],
    metadata: [] // subject, preheader, etc.
  };

  blocks.forEach((block) => {
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

    const { score, matchedWords, unmatchedWords, totalWords } = getSimilarityScore(block, emailText);
    const percentage = Math.round(score * 100);

    const blockResult = {
      originalText: block,
      matchPercentage: percentage,
      matchedWords: matchedWords.slice(0, 10), // Limit for readability
      unmatchedWords: unmatchedWords.slice(0, 10),
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
  return {
    overallStatus: data.textComparison.summary.notFound.length === 0 && data.missingDocLinks.length === 0 ? "PASS" : "FAIL",
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

    const { text: emailText, links: emailLinks } = await getEmailContent(emailUrl);
    console.log(`Extracted ${emailLinks.length} links from email`);

    // Use new detailed comparison
    const textComparison = compareTextDetailed(docText, emailText);

    const { report: linkReport, missing: missingDocLinks } = compareLinks(
      docLinks,
      emailLinks
    );

    // Check responsive design
    const { responsive, details: responsiveDetails } = await checkResponsive(emailUrl);

    // Clean up uploaded file
    fs.unlinkSync(file.path);

    // Return JSON response
    const result = formatResultJSON({
      textComparison,
      linkReport,
      missingDocLinks,
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
