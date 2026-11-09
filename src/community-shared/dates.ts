/*
 * Dates as the community shows them (dd/mm/yyyy), for the app's panel, the
 * website and the server's bot threads. The server's bundle imports this file
 * too: plain code only.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** dd/mm/yyyy of a UNIX time, in the reader's time zone. */
export function date(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** hh:mm of a UNIX time, in the reader's time zone. */
export function hhmm(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** dd/mm/yyyy hh:mm of a UNIX time, in the reader's time zone. */
export function dateTime(sec: number): string {
  return `${date(sec)} ${hhmm(sec)}`;
}

/** dd/mm/yyyy of a UNIX time in UTC: the same day wherever the server runs. */
export function utcDate(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
