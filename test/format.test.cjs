const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderedTextLength,
  renderTelegramChunkPairs,
  renderTelegramChunks,
  renderTelegramHtml,
  safeUrl,
} = require("../src/format.cjs");

test("renders supported Markdown as Telegram-safe HTML", () => {
  const markdown = [
    "# Heading & <unsafe>",
    "",
    "**bold** *italic* ~~gone~~ ||secret|| and `a < b`",
    "[OpenAI](https://openai.com/?a=1&b=2)",
    "> quoted **text**",
    "- first",
    "1. second",
    "```js",
    "if (a < b) console.log(\"ok\");",
    "```",
  ].join("\n");

  const html = renderTelegramHtml(markdown);
  assert.match(html, /<b>Heading &amp; &lt;unsafe&gt;<\/b>/);
  assert.match(html, /<b>bold<\/b> <i>italic<\/i> <s>gone<\/s> <tg-spoiler>secret<\/tg-spoiler>/);
  assert.match(html, /<code>a &lt; b<\/code>/);
  assert.match(html, /<a href="https:\/\/openai\.com\/\?a=1&amp;b=2">OpenAI<\/a>/);
  assert.match(html, /<blockquote>quoted <b>text<\/b><\/blockquote>/);
  assert.match(html, /• first/);
  assert.match(html, /1\. second/);
  assert.match(html, /<pre><code class="language-js">if \(a &lt; b\) console\.log\(&quot;ok&quot;\);<\/code><\/pre>/);
  assert.doesNotMatch(html, /<unsafe>/);
});

test("closes incomplete streaming code fences and leaves incomplete emphasis literal", () => {
  const html = renderTelegramHtml("Before **unfinished\n```ts\nconst x = 1 < 2");
  assert.match(html, /Before \*\*unfinished/);
  assert.match(html, /<pre><code class="language-ts">const x = 1 &lt; 2<\/code><\/pre>/);
});

test("keeps rendered chunks paired with their plain-text fallback", () => {
  const chunks = renderTelegramChunkPairs(`${"a".repeat(3600)}\n\n${"b".repeat(3600)}`);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.html === renderTelegramHtml(chunk.source)));
});

test("rejects unsafe links and chunks by rendered Telegram length", () => {
  assert.equal(safeUrl("javascript:alert(1)"), undefined);
  assert.equal(safeUrl("tg://resolve?domain=unsafe"), undefined);
  assert.equal(safeUrl("tg://user?id=123"), "tg://user?id=123");
  const html = renderTelegramHtml("[bad](javascript:alert(1))");
  assert.doesNotMatch(html, /<a /);

  const chunks = renderTelegramChunks(`**start**\n${"x".repeat(8000)}`);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => renderedTextLength(chunk) <= 3500));
  assert.match(chunks[0], /<b>start<\/b>/);

  const expanded = renderTelegramChunks(Array(875).fill("---").join("\n"));
  assert.ok(expanded.length > 1);
  assert.ok(expanded.every((chunk) => renderedTextLength(chunk) <= 3500));
});

test("honors escaped delimiters and cannot collide with protected token markers", () => {
  assert.equal(renderTelegramHtml("\\*literal\\* and \\_plain\\_"), "*literal* and _plain_");
  const marker = "\uE000TG0\uE001";
  const html = renderTelegramHtml(`${marker} and \`code\``);
  assert.match(html, new RegExp(marker));
  assert.match(html, /<code>code<\/code>/);
});
