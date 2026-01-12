function normalizeText(value) {
  return String(value || "").trim();
}

function removeWhitespace(value) {
  return String(value || "").replace(/\s+/g, "");
}

function isTimeQuery(rawText) {
  const text = normalizeText(rawText);
  if (!text) return false;

  const compact = removeWhitespace(text);

  // Chinese: current time/date/day-of-week.
  if (/几点/.test(compact)) return true;
  if (/(现在|此刻|当前)[\s\S]{0,8}(时间|时候|日期|几号|星期|周几)/.test(text)) return true;
  if (/(今天|今日)[\s\S]{0,8}(日期|几号|星期|周几)/.test(text)) return true;

  // Chinese: last chat time / elapsed time.
  if (/(上次|最后一次|之前)[\s\S]{0,12}(什么时候|时间)/.test(text)) return true;
  if (/(隔了|过去了|距离|相隔)[\s\S]{0,12}(多久|多长时间)/.test(text)) return true;

  // English.
  const lower = text.toLowerCase();
  if (/\bwhat\s+time\b/.test(lower)) return true;
  if (/\btime\s+is\s+it\b/.test(lower)) return true;
  if (/\bcurrent\s+time\b/.test(lower)) return true;
  if (/\btoday'?s\s+date\b/.test(lower)) return true;
  if (/\bwhat\s+date\b/.test(lower)) return true;
  if (/\bwhat\s+day\b/.test(lower)) return true;

  return false;
}

module.exports = {
  isTimeQuery,
};

