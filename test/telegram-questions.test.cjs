const assert = require("node:assert/strict");
const test = require("node:test");

const { parseQuestionCallback, questionKeyboard } = require("../src/telegram/questions.cjs");

test("builds and parses bounded Telegram question callbacks", () => {
  const questionId = "12345678-1234-1234-1234-123456789abc";
  const keyboard = questionKeyboard(questionId, ["Deploy", "Cancel"]);
  assert.equal(keyboard.inline_keyboard[0][0].text, "Deploy");
  assert.deepEqual(parseQuestionCallback(keyboard.inline_keyboard[1][0].callback_data), {
    questionId,
    optionIndex: 1,
  });
  assert.equal(parseQuestionCallback("question:bad:0"), undefined);
});
