const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createServer, generateAccessToken, MAX_FILE_BYTES } = require("../server");

const token = "test-access-token";
let dataDir;
let server;
let baseUrl;

async function startServer() {
  server = createServer({ token, dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (server?.listening) await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "X-Share-Token": token, ...options.headers }
  });
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wifi-share-test-"));
  await startServer();
});

after(async () => {
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("serves the app and rejects API requests without a token", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Wi-Fi Share/);

  const response = await fetch(`${baseUrl}/api/items`);
  assert.equal(response.status, 401);
});

test("shares text, rejects empty text, and deletes an item", async () => {
  const create = await request("/api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text", text: "hello from another device" })
  });
  assert.equal(create.status, 201);
  const item = await create.json();
  assert.equal(item.text, "hello from another device");

  const empty = await request("/api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text", text: "  " })
  });
  assert.equal(empty.status, 400);

  const remove = await request(`/api/items/${item.id}`, { method: "DELETE" });
  assert.equal(remove.status, 200);
  assert.deepEqual(await (await request("/api/items")).json(), []);
});

test("stores, serves, and persists an authenticated image", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const create = await request("/api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "image",
      mimeType: "image/png",
      fileName: "pixel.png",
      data: `data:image/png;base64,${bytes.toString("base64")}`
    })
  });
  assert.equal(create.status, 201);
  const item = await create.json();

  const image = await request(`/api/images/${item.id}`);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  assert.equal((await fetch(`${baseUrl}/api/images/${item.id}`)).status, 401);

  await stopServer();
  await startServer();
  const savedItems = await request("/api/items");
  assert.equal((await savedItems.json())[0].id, item.id);
});

test("streams, downloads, persists, and deletes general files", async () => {
  const bytes = Buffer.from("file contents\n");
  const create = await request("/api/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Type": "text/plain",
      "X-File-Name-Base64": Buffer.from("folder\\café notes.txt").toString("base64")
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 5));
        controller.enqueue(bytes.subarray(5));
        controller.close();
      }
    }),
    duplex: "half"
  });
  assert.equal(create.status, 201);
  const item = await create.json();
  assert.equal(item.fileName, "café notes.txt");
  assert.equal(item.fileSize, bytes.length);

  const download = await request(`/api/files/${item.id}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment;.*filename\*=UTF-8''caf%C3%A9%20notes\.txt/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await fetch(`${baseUrl}/api/files/${item.id}`)).status, 401);

  await stopServer();
  await startServer();
  const savedItems = await request("/api/items");
  assert.equal((await savedItems.json())[0].id, item.id);

  const remove = await request(`/api/items/${item.id}`, { method: "DELETE" });
  assert.equal(remove.status, 200);
  assert.equal((await request(`/api/files/${item.id}`)).status, 404);
});

test("accepts empty files and sets the general-file limit to 500 MB", async () => {
  assert.equal(MAX_FILE_BYTES, 500 * 1024 * 1024);
  const empty = await request("/api/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Type": "application/octet-stream",
      "X-File-Name-Base64": Buffer.from("empty.bin").toString("base64")
    },
    body: Buffer.alloc(0)
  });
  assert.equal(empty.status, 201);
  const item = await empty.json();
  assert.equal(item.fileSize, 0);
});

test("generates six-digit tokens, respects configured tokens, and limits failed attempts", async () => {
  assert.match(generateAccessToken(""), /^\d{6}$/);
  assert.equal(generateAccessToken("my-configured-token"), "my-configured-token");

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/items`, {
      headers: { "X-Share-Token": "incorrect-token" }
    });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${baseUrl}/api/items`, {
    headers: { "X-Share-Token": "incorrect-token" }
  });
  assert.equal(limited.status, 429);
});
