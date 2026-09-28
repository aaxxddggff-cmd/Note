// Thai public holidays that fall on the same date every year.
// Buddhist holidays (มาฆบูชา, วิสาขบูชา, อาสาฬหบูชา, เข้าพรรษา) follow the lunar calendar and
// substitute days are announced each year, so they are not included.

const FIXED = [
  ["01-01", "วันขึ้นปีใหม่"],
  ["04-06", "วันจักรี"],
  ["04-13", "วันสงกรานต์"],
  ["04-14", "วันสงกรานต์"],
  ["04-15", "วันสงกรานต์"],
  ["05-01", "วันแรงงานแห่งชาติ"],
  ["05-04", "วันฉัตรมงคล"],
  ["06-03", "วันเฉลิมพระชนมพรรษาสมเด็จพระราชินี"],
  ["07-28", "วันเฉลิมพระชนมพรรษา ร.10"],
  ["08-12", "วันแม่แห่งชาติ"],
  ["10-13", "วันนวมินทรมหาราช"],
  ["10-23", "วันปิยมหาราช"],
  ["12-05", "วันพ่อแห่งชาติ"],
  ["12-10", "วันรัฐธรรมนูญ"],
  ["12-31", "วันสิ้นปี"],
];

const cache = new Map();

/** { "YYYY-MM-DD": name } for the given year. */
export function holidaysOf(year) {
  if (!cache.has(year)) cache.set(year, Object.fromEntries(FIXED.map(([md, name]) => [`${year}-${md}`, name])));
  return cache.get(year);
}

/** Holidays covering every year touched by [fromKey, toKey]. */
export function holidaysBetween(fromKey, toKey) {
  const out = {};
  for (let y = Number(fromKey.slice(0, 4)); y <= Number(toKey.slice(0, 4)); y++) Object.assign(out, holidaysOf(y));
  return out;
}

/** The next holiday on or after the given date key: { date, name }. */
export function nextHoliday(fromKey) {
  const y = Number(fromKey.slice(0, 4));
  const all = { ...holidaysOf(y), ...holidaysOf(y + 1) };
  const date = Object.keys(all).sort().find((k) => k >= fromKey);
  return { date, name: all[date] };
}
