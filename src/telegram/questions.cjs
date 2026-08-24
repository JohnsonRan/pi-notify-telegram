function questionCallbackData(questionId, optionIndex) {
  return `question:${questionId}:${optionIndex}`;
}

function parseQuestionCallback(value) {
  const match = String(value || "").match(/^question:([0-9a-f-]{36}):(\d{1,2})$/i);
  if (!match) return undefined;
  return { questionId: match[1], optionIndex: Number(match[2]) };
}

function questionKeyboard(questionId, options) {
  return {
    inline_keyboard: options.map((option, index) => [{
      text: String(option).slice(0, 64),
      callback_data: questionCallbackData(questionId, index),
    }]),
  };
}

module.exports = Object.freeze({ parseQuestionCallback, questionCallbackData, questionKeyboard });
