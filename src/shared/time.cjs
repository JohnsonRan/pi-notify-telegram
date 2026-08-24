function formatLocalTimestamp(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetRemainder = Math.abs(offsetMinutes) % 60;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offsetSign}${pad(offsetHours)}:${pad(offsetRemainder)}`;
}

module.exports = Object.freeze({ formatLocalTimestamp });
