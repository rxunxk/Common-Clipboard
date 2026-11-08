const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const MAX_TEXT_LENGTH = 100_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 32_000;
const AUTH_FAILURE_LIMIT = 10;
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"]
]);

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const error = new Error("Request body is too large.");
        error.status = 413;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("Request body must be valid JSON.");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function generateAccessToken(configuredToken = process.env.SHARE_TOKEN) {
  return configuredToken || String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function createServer({ token, dataDir }) {
  if (!token) throw new Error("An access token is required.");
  if (!dataDir) throw new Error("A data directory is required.");

  const imageDir = path.join(dataDir, "images");
  const fileDir = path.join(dataDir, "files");
  const itemsPath = path.join(dataDir, "items.json");
  let items = [];
  let ready;
  let saveQueue = Promise.resolve();
  const authFailures = new Map();

  async function saveItems() {
    saveQueue = saveQueue.then(async () => {
      const tempPath = `${itemsPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(items), "utf8");
      await fs.rename(tempPath, itemsPath);
    });
    await saveQueue;
  }

  async function initialize() {
    await fs.mkdir(imageDir, { recursive: true });
    await fs.mkdir(fileDir, { recursive: true });
    try {
      const stored = JSON.parse(await fs.readFile(itemsPath, "utf8"));
      if (!Array.isArray(stored)) throw new Error("Stored items must be an array.");
      items = stored;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await saveItems();
    }
  }

  function checkAuthorization(req, res) {
    const address = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const failures = (authFailures.get(address) || []).filter(
      (timestamp) => now - timestamp < AUTH_FAILURE_WINDOW_MS
    );
    if (failures.length >= AUTH_FAILURE_LIMIT) {
      authFailures.set(address, failures);
      sendJson(res, 429, { error: "Too many incorrect access tokens. Try again in a few minutes." });
      return false;
    }

    const supplied = req.headers["x-share-token"];
    if (typeof supplied === "string") {
      const suppliedBuffer = Buffer.from(supplied);
      const tokenBuffer = Buffer.from(token);
      if (suppliedBuffer.length === tokenBuffer.length
        && crypto.timingSafeEqual(suppliedBuffer, tokenBuffer)) {
        authFailures.delete(address);
        return true;
      }
    }

    failures.push(now);
    authFailures.set(address, failures);
    sendJson(res, 401, { error: "Enter the access token shown in the server terminal." });
    return false;
  }

  const server = http.createServer(async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/" && req.method === "GET") {
        const page = await fs.readFile(path.join(__dirname, "public", "index.html"));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
        });
        res.end(page);
        return;
      }

      if (url.pathname.startsWith("/api/") && !checkAuthorization(req, res)) return;

      if (url.pathname === "/api/items" && req.method === "GET") {
        sendJson(res, 200, items);
        return;
      }

      if (url.pathname === "/api/files" && req.method === "POST") {
        const contentLength = Number(req.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
          req.resume();
          sendJson(res, 413, { error: "Files must be 500 MB or smaller." });
          return;
        }

        const encodedName = req.headers["x-file-name-base64"];
        const mimeType = req.headers["x-file-type"];
        let fileName = "";
        if (typeof encodedName === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(encodedName)) {
          fileName = Buffer.from(encodedName, "base64")
            .toString("utf8")
            .split(/[\\/]/)
            .pop()
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .trim()
            .slice(0, 200);
        }
        if (!fileName || typeof mimeType !== "string"
          || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mimeType)) {
          req.resume();
          sendJson(res, 400, { error: "The file name or type is invalid." });
          return;
        }

        const id = crypto.randomUUID();
        const tempPath = path.join(fileDir, `${id}.tmp`);
        let fileHandle;
        let size = 0;
        let tooLarge = false;
        try {
          fileHandle = await fs.open(tempPath, "wx");
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_FILE_BYTES) {
              tooLarge = true;
              continue;
            }
            await fileHandle.writeFile(chunk);
          }
          await fileHandle.close();
          fileHandle = null;
          if (tooLarge) {
            await fs.rm(tempPath, { force: true });
            sendJson(res, 413, { error: "Files must be 500 MB or smaller." });
            return;
          }

          const item = {
            id,
            type: "file",
            mimeType,
            fileName,
            fileSize: size,
            createdAt: new Date().toISOString()
          };
          await fs.rename(tempPath, path.join(fileDir, id));
          items.unshift(item);
          await saveItems();
          sendJson(res, 201, item);
        } catch (error) {
          if (fileHandle) await fileHandle.close();
          await fs.rm(tempPath, { force: true });
          throw error;
        }
        return;
      }

      if (url.pathname === "/api/items" && req.method === "POST") {
        const body = await readJson(req);
        if (body.type === "text") {
          if (typeof body.text !== "string" || !body.text.trim()) {
            sendJson(res, 400, { error: "Text cannot be empty." });
            return;
          }
          if (body.text.length > MAX_TEXT_LENGTH) {
            sendJson(res, 413, { error: "Text is limited to 100,000 characters." });
            return;
          }
          const item = {
            id: crypto.randomUUID(),
            type: "text",
            text: body.text,
            createdAt: new Date().toISOString()
          };
          items.unshift(item);
          await saveItems();
          sendJson(res, 201, item);
          return;
        }

        if (body.type === "image") {
          const extension = IMAGE_TYPES.get(body.mimeType);
          if (!extension || typeof body.data !== "string") {
            sendJson(res, 400, { error: "Choose a JPEG, PNG, GIF, or WebP image." });
            return;
          }
          const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(body.data);
          if (!match || match[1] !== body.mimeType) {
            sendJson(res, 400, { error: "The image data is invalid." });
            return;
          }
          const bytes = Buffer.from(match[2], "base64");
          if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== match[2]) {
            sendJson(res, 413, { error: "Images must be smaller than 8 MB and use valid base64 data." });
            return;
          }
          const id = crypto.randomUUID();
          const item = {
            id,
            type: "image",
            mimeType: body.mimeType,
            fileName: typeof body.fileName === "string" ? path.basename(body.fileName).slice(0, 200) : `image.${extension}`,
            createdAt: new Date().toISOString()
          };
          await fs.writeFile(path.join(imageDir, `${id}.${extension}`), bytes, { flag: "wx" });
          items.unshift(item);
          await saveItems();
          sendJson(res, 201, item);
          return;
        }

        sendJson(res, 400, { error: "Item type must be text or image." });
        return;
      }

      const fileMatch = /^\/api\/files\/([0-9a-f-]+)$/.exec(url.pathname);
      if (fileMatch && req.method === "GET") {
        const item = items.find((entry) => entry.id === fileMatch[1] && entry.type === "file");
        if (!item) {
          sendJson(res, 404, { error: "File not found." });
          return;
        }
        const filePath = path.join(fileDir, item.id);
        const fileInfo = await fs.stat(filePath);
        const safeFileName = item.fileName.replace(/[^\x20-\x7e"\\]/g, "_").replace(/["\\]/g, "_");
        const encodedFileName = encodeURIComponent(Buffer.from(item.fileName, "utf8").toString("utf8"));
        res.writeHead(200, {
          "Content-Type": item.mimeType,
          "Content-Length": fileInfo.size,
          "Content-Disposition": `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff"
        });
        const stream = fsSync.createReadStream(filePath);
        stream.on("error", (error) => res.destroy(error));
        stream.pipe(res);
        return;
      }

      const imageMatch = /^\/api\/images\/([0-9a-f-]+)$/.exec(url.pathname);
      if (imageMatch && req.method === "GET") {
        const item = items.find((entry) => entry.id === imageMatch[1] && entry.type === "image");
        if (!item) {
          sendJson(res, 404, { error: "Image not found." });
          return;
        }
        const extension = IMAGE_TYPES.get(item.mimeType);
        const imagePath = path.join(imageDir, `${item.id}.${extension}`);
        const image = await fs.readFile(imagePath);
        res.writeHead(200, {
          "Content-Type": item.mimeType,
          "Content-Length": image.length,
          "Content-Disposition": `inline; filename="${item.fileName.replace(/["\\\r\n]/g, "_")}"`,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(image);
        return;
      }

      const deleteMatch = /^\/api\/items\/([0-9a-f-]+)$/.exec(url.pathname);
      if (deleteMatch && req.method === "DELETE") {
        const index = items.findIndex((entry) => entry.id === deleteMatch[1]);
        if (index === -1) {
          sendJson(res, 404, { error: "Item not found." });
          return;
        }
        const [item] = items.splice(index, 1);
        if (item.type === "image") {
          const extension = IMAGE_TYPES.get(item.mimeType);
          await fs.rm(path.join(imageDir, `${item.id}.${extension}`), { force: true });
        } else if (item.type === "file") {
          await fs.rm(path.join(fileDir, item.id), { force: true });
        }
        await saveItems();
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      console.error(error);
      sendJson(res, error.status || 500, {
        error: error.status ? error.message : "The server could not complete the request."
      });
    }
  });

  ready = initialize();
  return server;
}

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

if (require.main === module) {
  const token = generateAccessToken();
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
  const server = createServer({ token, dataDir });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Wi-Fi Share is running on port ${PORT}.`);
    console.log(`Access token: ${token}`);
    for (const address of getLanAddresses()) {
      console.log(`Open on this Wi-Fi: http://${address}:${PORT}`);
    }
  });
}

module.exports = { createServer, generateAccessToken, MAX_FILE_BYTES };
