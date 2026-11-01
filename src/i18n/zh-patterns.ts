/*
 * Chinese text the dictionary can't list because it holds a value: dates and short sentences around a number.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS: Record<string, string> = { Mon: "一", Tue: "二", Wed: "三", Thu: "四", Fri: "五", Sat: "六", Sun: "日" };

const MON = MONTHS.join("|");
const monthNumber = (name: string) => (MONTHS.includes(name) ? MONTHS.indexOf(name) : LONG_MONTHS.indexOf(name)) + 1;
const fullYear = (y: string) => (y.length === 2 ? `20${y}` : y);

type Rule = (text: string) => string;

/** The rules of one script (`week` and `lastUpdate` differ between Simplified and Traditional). */
export function zhRules(words: { week: string; lastUpdate: string; leftToCover: string; drawings: string; indicators: string }): Rule[] {
  return [
    // Mon 26 Oct '26   14:30, the chart's time label
    (t) => t.replace(new RegExp(`\\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\\d{1,2}) (${MON}) '(\\d{2})`, "g"), (_, d, day, m, y) => `${fullYear(y)}年${monthNumber(m)}月${Number(day)}日 ${words.week}${DAYS[d]}`),
    // Sep 10, 2003
    (t) => t.replace(new RegExp(`\\b(${MON}) (\\d{1,2}), (\\d{4})\\b`, "g"), (_, m, day, y) => `${y}年${monthNumber(m)}月${Number(day)}日`),
    // November 2026, Nov 2026
    (t) => t.replace(new RegExp(`\\b(${LONG_MONTHS.join("|")}|${MON}) (\\d{4})\\b`, "g"), (_, m, y) => `${y}年${monthNumber(m)}月`),
    // A time-axis month
    (t) => (MONTHS.includes(t) ? `${monthNumber(t)}月` : t),
    (t) => t.replace(/^Last update at /, `${words.lastUpdate} `),
    (t) => t.replace(/^(.+) left to cover$/, `${words.leftToCover} $1`),
    (t) => t.replace(/^(\d+) drawings?$/, `$1 ${words.drawings}`),
    (t) => t.replace(/^(\d+) indicators?$/, `$1 ${words.indicators}`),
  ];
}

export const SIMPLIFIED_RULES = zhRules({ week: "周", lastUpdate: "最后更新于", leftToCover: "尚需", drawings: "个绘图", indicators: "个指标" });
export const TRADITIONAL_RULES = zhRules({ week: "週", lastUpdate: "最後更新於", leftToCover: "尚需", drawings: "個繪圖", indicators: "個指標" });
