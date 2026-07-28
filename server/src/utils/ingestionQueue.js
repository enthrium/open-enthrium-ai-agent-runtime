const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { upsertChunksBatched } = require("./vectorStore");

const OCR_MIME_MAP = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif",  ".webp": "image/webp",  ".tiff": "image/tiff", ".bmp": "image/bmp"
};
const OCR_PROMPT =
  "Extract ALL text from this image exactly as it appears. " +
  "Preserve headings, bullet points, numbered lists, tables, and paragraph structure. " +
  "Return only the extracted text — no commentary, no explanation, nothing else.";

const PROCESSOR_URL = `http://localhost:${process.env.PROCESSOR_PORT || 5002}`;
const EMBED_BATCH_SIZE = 10;

async function getChunkSettings(db) {
  const rows = await db.setting.findMany({ where: { key: { in: ["chunk_size", "chunk_overlap"] } } });
  const map  = Object.fromEntries(rows.map(r => [r.key, parseInt(r.value)]));
  return { chunkSize: map.chunk_size || 1000, chunkOverlap: map.chunk_overlap || 150 };
}

class IngestionQueue {
  constructor() {
    this._queue   = [];
    this._running = false;
  }

  /**
   * Add a document job to the queue.
   * @param {object}  db                Prisma client
   * @param {object}  workspace         { id, slug, name }
   * @param {object}  doc               { uid, name, ... }
   * @param {string}  source            file path or URL string
   * @param {string}  sourceType        "file" | "url"
   * @param {boolean} keepFile          don't delete temp file after processing
   * @param {number}  uploadedByUserId  user who triggered the ingestion
   */
  enqueue(db, workspace, doc, source, sourceType = "file", keepFile = false, uploadedByUserId = null) {
    this._queue.push({ db, workspace, doc, source, sourceType, keepFile, uploadedByUserId });
    if (!this._running) this._run();
  }

  async _run() {
    this._running = true;
    while (this._queue.length > 0) {
      const job = this._queue.shift();
      await this._processJob(job).catch(e => console.error("[Queue] job error:", e.message));
    }
    this._running = false;
  }

  async _processJob({ db, workspace, doc, source, sourceType, keepFile, uploadedByUserId }) {
    // Mark ingesting
    try {
      await db.document.update({
        where: { uid: doc.uid },
        data: { status: "ingesting", chunksProcessed: 0, totalChunks: 0, cancelRequested: false, errorMessage: null }
      });
    } catch {
      return; // doc may have been deleted while queued
    }

    try {
      // ── 1. Extract text + chunk via processor ─────────────────────────
      const { chunkSize, chunkOverlap } = await getChunkSettings(db);
      let chunks;

      if (sourceType === "website-crawl") {
        // ── BFS crawl: discover pages, create + enqueue each as a URL doc ──
        const { startUrl, maxPages, maxDepth } = JSON.parse(source);
        const origin = new URL(startUrl).origin;
        const visited  = new Set();
        const bfsQueue = [{ url: startUrl, depth: 0 }];
        const toIngest = [];

        while (bfsQueue.length > 0 && toIngest.length < maxPages) {
          const { url: raw, depth } = bfsQueue.shift();
          let normalized;
          try { const u = new URL(raw); u.hash = ""; normalized = u.toString(); } catch { continue; }
          if (visited.has(normalized)) continue;
          visited.add(normalized);

          try {
            const resp = await fetch(normalized, {
              headers: { "User-Agent": "OpenEnterprise-Crawler/1.0" },
              redirect: "follow",
              signal: AbortSignal.timeout(8000)
            });
            if (!resp.ok) continue;
            const ct = resp.headers.get("content-type") || "";
            if (!ct.includes("text/html")) continue;
            const html = await resp.text();
            toIngest.push(normalized);

            if (depth < maxDepth) {
              const linkRe = /href=["']([^"'#]+)["']/gi;
              let m;
              while ((m = linkRe.exec(html)) !== null) {
                try {
                  const linked = new URL(m[1], normalized);
                  linked.hash = "";
                  if (linked.origin === origin && !visited.has(linked.toString()))
                    bfsQueue.push({ url: linked.toString(), depth: depth + 1 });
                } catch { /* skip */ }
              }
            }
          } catch { /* skip unreachable */ }
        }

        if (!toIngest.length) throw new Error("No pages could be fetched from that URL");

        for (const url of toIngest) {
          const urlDoc = await db.document.create({
            data: { uid: uuidv4(), name: url, type: "url", workspaceId: workspace.id, status: "queued", uploadedByUserId }
          });
          ingestionQueue.enqueue(db, workspace, urlDoc, url, "url", false, uploadedByUserId);
        }

        // Mark the crawler tracker doc as ready (it has no chunks of its own)
        await db.document.update({
          where: { uid: doc.uid },
          data: { status: "ready", chunkCount: toIngest.length, chunksProcessed: toIngest.length, totalChunks: toIngest.length, uploadedByUserId }
        });
        return;

      } else if (sourceType === "ocr") {
        // ── OCR: LLM Vision → text → processor ───────────────────────
        if (!fs.existsSync(source)) throw new Error("Image file not found: " + source);

        const mimeType = OCR_MIME_MAP[path.extname(source).toLowerCase()] || "image/jpeg";
        const base64   = fs.readFileSync(source).toString("base64");

        const { getLLMClient, getSetting } = require("../providers/llm");
        const { provider, client } = await getLLMClient();
        const model = (await getSetting("llm_model")) || (provider === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o");

        let extractedText = "";
        if (provider === "anthropic") {
          const response = await client.messages.create({
            model, max_tokens: 4096,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
              { type: "text",  text: OCR_PROMPT }
            ]}]
          });
          extractedText = response.content?.[0]?.text || "";
        } else {
          const response = await client.chat.completions.create({
            model, max_tokens: 4096,
            messages: [{ role: "user", content: [
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" } },
              { type: "text",      text: OCR_PROMPT }
            ]}]
          });
          extractedText = response.choices?.[0]?.message?.content || "";
        }

        if (!extractedText.trim()) throw new Error("No text could be extracted from this image");

        // Write extracted text to a temp .txt file, process normally
        const UPLOAD_DIR = path.join(__dirname, "../../storage/uploads/");
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const txtPath = path.join(UPLOAD_DIR, uuidv4() + ".txt");
        fs.writeFileSync(txtPath, extractedText, "utf-8");

        try {
          const form = new FormData();
          form.append("file", fs.createReadStream(txtPath), doc.name.replace(/ \(OCR\)$/, "") + ".txt");
          form.append("chunkSize",    String(chunkSize));
          form.append("chunkOverlap", String(chunkOverlap));
          const { data } = await axios.post(`${PROCESSOR_URL}/process/file`, form, {
            headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity
          });
          chunks = data.chunks;
        } finally {
          fs.unlink(txtPath, () => {});
        }

      } else if (sourceType === "url") {
        const { data } = await axios.post(`${PROCESSOR_URL}/process/url`, { url: source, chunkSize, chunkOverlap });
        chunks = data.chunks;
      } else {
        if (!fs.existsSync(source)) throw new Error("Source file not found: " + source);
        const form = new FormData();
        form.append("file", fs.createReadStream(source), doc.name);
        form.append("chunkSize",    String(chunkSize));
        form.append("chunkOverlap", String(chunkOverlap));
        const { data } = await axios.post(`${PROCESSOR_URL}/process/file`, form, {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength:    Infinity
        });
        chunks = data.chunks;
      }

      // Store total so the UI can show X / Y
      await db.document.update({ where: { uid: doc.uid }, data: { totalChunks: chunks.length } });

      // Calculate content size (for URL/OCR docs that had no file size at upload)
      const contentSize = chunks.reduce((sum, c) => sum + Buffer.byteLength(c.text || "", "utf8"), 0);

      // ── 2. Embed + upsert in batches, checking cancel between each ────
      const { chunksProcessed: processed, embeddingTokens, embeddingModel } = await upsertChunksBatched(workspace.slug, doc.uid, chunks, {
        batchSize:    EMBED_BATCH_SIZE,
        onProgress:   async (count) => {
          await db.document.update({ where: { uid: doc.uid }, data: { chunksProcessed: count } });
        },
        shouldCancel: async () => {
          const row = await db.document.findUnique({ where: { uid: doc.uid }, select: { cancelRequested: true } });
          return row?.cancelRequested === true;
        }
      });

      // ── 3. Finalise status ─────────────────────────────────────────────
      const wasCancelled = processed < chunks.length;
      const sizeUpdate = (sourceType === "url" || sourceType === "ocr") ? { size: contentSize } : {};
      await db.document.update({
        where: { uid: doc.uid },
        data: wasCancelled
          ? { status: processed > 0 ? "partial" : "failed", chunkCount: processed, cancelRequested: false, embeddingTokens, embeddingModel, uploadedByUserId, ...sizeUpdate }
          : { status: "ready", chunkCount: processed, chunksProcessed: processed, cancelRequested: false, embeddingTokens, embeddingModel, uploadedByUserId, ...sizeUpdate }
      });
    } catch (err) {
      console.error(`[Queue] Ingestion failed for ${doc.uid}:`, err.message);
      await db.document.update({
        where: { uid: doc.uid },
        data: { status: "failed", errorMessage: err.message }
      }).catch(() => {});
    } finally {
      if (!keepFile && sourceType !== "url" && sourceType !== "website-crawl") fs.unlink(source, () => {});
    }
  }
}

const ingestionQueue = new IngestionQueue();
module.exports = ingestionQueue;
