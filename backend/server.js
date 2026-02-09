import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import { chromium } from "playwright";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ES module dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Handle favicon requests
app.get('/favicon.ico', (req, res) => res.status(204).end());

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
// SCRAPE EMAIL
// ---------------------------------------------------------
async function getEmailContent(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });

  const text = await page.evaluate(() => document.body.innerText || "");

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a")).map((a) => ({
      text: a.innerText.trim(),
      href: a.href || "",
    }))
  );

  const images = await page.evaluate(() =>
    Array.from(document.querySelectorAll("img")).map((img) => ({
      src: img.src || "",
      alt: img.alt || "",
    }))
  );

  await browser.close();
  return { text, links, images };
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
// RESPONSIVE CHECK WITH SAVED SCREENSHOTS
// ---------------------------------------------------------
async function captureScreenshots(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  // Ensure screenshots directory exists
  if (!fs.existsSync('screenshots')) {
    fs.mkdirSync('screenshots');
  }

  // DESKTOP VIEW
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(url, { waitUntil: "networkidle" });

  const desktopScreenshot = await page.screenshot({ fullPage: true });
  fs.writeFileSync('screenshots/desktop.png', desktopScreenshot);

  const desktopMainWidth = await page.evaluate(() => {
    const maxWidth = Math.max(
      ...Array.from(document.querySelectorAll("*")).map(el => el.clientWidth || 0)
    );
    return maxWidth;
  });

  // MOBILE VIEW
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload({ waitUntil: "networkidle" });

  const mobileScreenshot = await page.screenshot({ fullPage: true });
  fs.writeFileSync('screenshots/mobile.png', mobileScreenshot);

  const mobileMainWidth = await page.evaluate(() => {
    const maxWidth = Math.max(
      ...Array.from(document.querySelectorAll("*")).map(el => el.clientWidth || 0)
    );
    return maxWidth;
  });

  await browser.close();

  // NEW RESPONSIVE LOGIC
  const responsive =
    mobileMainWidth < desktopMainWidth - 100
      ? "YES – Layout changes on mobile"
      : "NO – Layout remains similar";

  return {
    desktopScreenshot,
    mobileScreenshot,
    responsive
  };
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
    screenshots: {
      desktop: `/screenshots/desktop.png?t=${Date.now()}`,
      mobile: `/screenshots/mobile.png?t=${Date.now()}`
    }
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

    const { docText, docLinks } = await extractDoc(file.path);
    const { text: emailText, links: emailLinks } = await getEmailContent(emailUrl);

    // Use new detailed comparison
    const textComparison = compareTextDetailed(docText, emailText);

    const { report: linkReport, missing: missingDocLinks } = compareLinks(
      docLinks,
      emailLinks
    );
    const { desktopScreenshot, mobileScreenshot, responsive } =
      await captureScreenshots(emailUrl);

    fs.unlinkSync(file.path);

    // Return JSON response
    const result = formatResultJSON({
      textComparison,
      linkReport,
      missingDocLinks,
      responsive
    });

    res.json(result);
  } catch (err) {
    console.error("QA Processing Error:", err.message);
    console.error("Stack trace:", err.stack);
    res.status(500).json({ error: "QA processing failed", details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 QA Server running on port ${PORT}`));
