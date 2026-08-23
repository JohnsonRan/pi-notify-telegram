const MAX_LINE_BYTES = 256 * 1024;
const PROTOCOL_VERSION = 2;

function sendLine(socket, value) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function attachLineReader(socket, onMessage, onError) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
      socket.destroy(new Error("Telegram bridge frame is too large"));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (error) {
        onError(error);
      }
    }
  });
}

module.exports = Object.freeze({ PROTOCOL_VERSION, attachLineReader, sendLine });
