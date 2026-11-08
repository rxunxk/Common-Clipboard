# Wi-Fi Share

A small, private sharing board for text, images, and files between devices on the same Wi-Fi network. The app does not read your system clipboard automatically: paste or type text into the page, then use **Copy text** on the other device. To share an image, focus the text box and paste (Ctrl+V); supported browsers will share a pasted image automatically. You can also use **Choose an image** or **Choose a file**.

## Run it

1. Install Node.js 20 or newer on the computer that will host the app.
2. In this folder, run `npm start`.
3. In the terminal output, note the access token and open the printed `http://...` address on your other device.
4. Enter the token in the page. Both devices must be on the same Wi-Fi network.

If Windows Firewall asks, allow Node.js on your **private network** so your other device can connect. Do not expose this app to the public internet.

If file uploads show **Not found**, stop the old server with Ctrl+C in its terminal, run `npm start` again, and reload the page. Node does not automatically reload server code after updates.

## Settings and data

- `PORT` sets the listening port (default `3000`).
- `SHARE_TOKEN` sets a fixed access token. If omitted, a new random six-digit token is generated each time the app starts. After 10 incorrect attempts from one client within five minutes, further attempts from that client are temporarily blocked.
- `DATA_DIR` sets where shared items are stored (default `./data`).
- Text, images, and files remain on the host computer until you delete them. The `data` folder is excluded from Git.
- The app accepts text up to 100,000 characters, JPEG, PNG, GIF, or WebP images up to 8 MB, and general files up to 500 MB each. General files upload as a stream and download as a stream, so the app does not keep a second Base64 copy of a large file in memory. The host needs enough disk space for shared files.
- Image paste reads image data explicitly provided by the paste event; it does not request background clipboard access. Browser or organization policies may still block clipboard images or the app's network requests. Encoding an image as Base64 text does not bypass those restrictions and makes the data larger.
- A six-digit token is convenient but less secure than a longer password. The app is intended for a trusted private Wi-Fi network; use a longer `SHARE_TOKEN` if you need stronger protection.

Run `npm test` to execute the automated API tests.
