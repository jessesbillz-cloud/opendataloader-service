const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const { OpenDataLoaderPDF } = require("@opendataloader/pdf");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Multer: store uploads in /tmp with original extension ──
const storage = multer.diskStorage({
  destination: "/tmp/uploads",
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [".pdf", ".docx", ".doc", ".jpg", ".jpeg", ".png", ".heic"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${ext}`));
  },
});

// Ensure upload dir exists
fs.mkdirSync("/tmp/uploads", { recursive: true });

// ── Helpers ──

/** Convert HEIC → JPG using sharp */
async function heicToJpg(inputPath) {
  const sharp = require("sharp");
  const outPath = inputPath.replace(/\.heic$/i, ".jpg");
  await sharp(inputPath).jpeg({ quality: 90 }).toFile(outPath);
  return outPath;
}

/** Convert image (JPG/PNG) → PDF using ImageMagick */
function imageToPdf(inputPath) {
  const outPath = inputPath.replace(/\.\w+$/, ".pdf");
  execSync(`convert "${inputPath}" "${outPath}"`, { timeout: 30_000 });
  return outPath;
}

/** Convert DOCX/DOC → PDF using LibreOffice headless */
function officeToPdf(inputPath) {
  const dir = path.dirname(inputPath);
  execSync(
    `libreoffice --headless --convert-to pdf --outdir "${dir}" "${inputPath}"`,
    { timeout: 60_000 }
  );
  return inputPath.replace(/\.\w+$/, ".pdf");
}

/** Ensure we have a PDF, converting if necessary */
async function ensurePdf(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") return filePath;

  if (ext === ".heic") {
    const jpg = await heicToJpg(filePath);
    return imageToPdf(jpg);
  }

  if ([".jpg", ".jpeg", ".png"].includes(ext)) {
    return imageToPdf(filePath);
  }

  if ([".docx", ".doc"].includes(ext)) {
    return officeToPdf(filePath);
  }

  throw new Error(`Cannot convert ${ext} to PDF`);
}

/** Clean up temp files (best-effort) */
function cleanup(...paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

// ── Routes ──

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/parse", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Send multipart form-data with a 'file' field." });
  }

  const originalPath = req.file.path;
  let pdfPath = null;

  try {
    // Step 1: Convert to PDF if needed
    pdfPath = await ensurePdf(originalPath);

    // Step 2: Run OpenDataLoader PDF
    const loader = new OpenDataLoaderPDF(pdfPath, { format: "json" });
    const result = await loader.load();

    res.json({
      success: true,
      filename: req.file.originalname,
      pages: result.length,
      data: result,
    });
  } catch (err) {
    console.error("Parse error:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to parse file",
    });
  } finally {
    // Clean up all temp files
    cleanup(originalPath, pdfPath !== originalPath ? pdfPath : null);
    // Also clean intermediate files (HEIC→JPG)
    const jpgIntermediate = originalPath.replace(/\.heic$/i, ".jpg");
    if (jpgIntermediate !== originalPath) cleanup(jpgIntermediate);
  }
});

// ── Error handler for multer ──
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`OpenDataLoader service running on port ${PORT}`);
});
