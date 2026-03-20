const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

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

/** Clean up a directory (best-effort) */
function cleanupDir(dirPath) {
  try {
    if (dirPath && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {}
}

// ── Routes ──

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/** Load OpenDataLoader (handles both CJS and ESM packages) */
let _odlModule = null;
async function getODL() {
  if (_odlModule) return _odlModule;
  try {
    _odlModule = require("@opendataloader/pdf");
  } catch (e) {
    // Fallback: dynamic import for ESM-only packages
    _odlModule = await import("@opendataloader/pdf");
  }
  console.log("ODL module exports:", Object.keys(_odlModule));
  return _odlModule;
}

app.post("/parse", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Send multipart form-data with a 'file' field." });
  }

  console.log("Uploaded file:", req.file.originalname, "path:", req.file.path);

  const originalPath = req.file.path;
  let pdfPath = null;
  const outputDir = path.join("/tmp", `odl-out-${Date.now()}`);

  try {
    // Step 1: Convert to PDF if needed
    pdfPath = await ensurePdf(originalPath);
    console.log("PDF path:", pdfPath, "exists:", fs.existsSync(pdfPath));

    // Step 2: Load OpenDataLoader and run convert
    const odl = await getODL();
    const convert = odl.convert || odl.default?.convert || odl.default;

    if (typeof convert !== "function") {
      // Dump available exports for debugging
      const keys = Object.keys(odl);
      throw new Error(`No 'convert' function found. Available exports: ${keys.join(", ")}`);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    // Try the documented API: convert(paths[], options)
    // If that fails, try alternative signatures
    try {
      await convert([pdfPath], { outputDir, format: "json" });
    } catch (err1) {
      console.log("API attempt 1 failed:", err1.message);
      try {
        // Try single string instead of array
        await convert(pdfPath, { outputDir, format: "json" });
      } catch (err2) {
        console.log("API attempt 2 failed:", err2.message);
        try {
          // Try with input_path named param (Python-style)
          await convert({ inputPath: pdfPath, outputDir, format: "json" });
        } catch (err3) {
          console.log("API attempt 3 failed:", err3.message);
          // Try format as array
          await convert([pdfPath], { outputDir, format: ["json"] });
        }
      }
    }

    // Step 3: Read the JSON output file
    const baseName = path.basename(pdfPath, ".pdf");
    const jsonPath = path.join(outputDir, `${baseName}.json`);

    console.log("Looking for output at:", jsonPath);
    console.log("Output dir contents:", fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : "DIR NOT FOUND");

    let result;
    if (fs.existsSync(jsonPath)) {
      result = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    } else {
      // Fallback: find any .json file in the output dir
      const files = fs.readdirSync(outputDir).filter(f => f.endsWith(".json"));
      if (files.length > 0) {
        result = JSON.parse(fs.readFileSync(path.join(outputDir, files[0]), "utf-8"));
      } else {
        throw new Error("OpenDataLoader produced no JSON output. Dir contents: " +
          fs.readdirSync(outputDir).join(", "));
      }
    }

    const pages = Array.isArray(result) ? result.length : (result.pages ? result.pages.length : 1);

    res.json({
      success: true,
      filename: req.file.originalname,
      pages,
      data: result,
    });
  } catch (err) {
    console.error("Parse error:", err.stack || err);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to parse file",
      stack: process.env.NODE_ENV !== "production" ? err.stack : undefined,
    });
  } finally {
    cleanup(originalPath, pdfPath !== originalPath ? pdfPath : null);
    const jpgIntermediate = originalPath.replace(/\.heic$/i, ".jpg");
    if (jpgIntermediate !== originalPath) cleanup(jpgIntermediate);
    cleanupDir(outputDir);
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
